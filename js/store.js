// 저장소 계층 — LocalStore(설정 없이 바로 동작) / CloudStore(Supabase, 링크 공유·실시간·지표)
// 두 저장소는 같은 메서드와 같은 trip 객체 모양을 쓴다.
//
// trip = { id, name, baseCurrency, createdAt, settledAt,
//          participants: [{ id, name, payInfo: { toss, kakao, account } }],
//          expenses: [{ id, title, date, amount, currency, rate, baseOverride,
//                       payerId, shares: [{ pid, w }], device, createdAt, deletedAt }] }

import { tidyTrip } from './settle.js?v=202610071621';

const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 사생활 보호 모드 등 */ } },
};

export function uid(len = 16) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

export function deviceId() {
  let d = LS.get('enbbang:device');
  if (!d) { d = uid(12); LS.set('enbbang:device', d); }
  return d;
}

// 이 기기에서 각 여행방의 "나"가 누구인지 / 총무 키
export const me = {
  get: (tripId) => LS.get(`enbbang:me:${tripId}`),
  set: (tripId, pid) => LS.set(`enbbang:me:${tripId}`, pid),
  adminKey: (tripId) => LS.get(`enbbang:admin:${tripId}`),
  setAdminKey: (tripId, k) => LS.set(`enbbang:admin:${tripId}`, k),
};

function rememberTrip(trip) {
  const list = LS.get('enbbang:recent', []).filter((t) => t.id !== trip.id);
  list.unshift({ id: trip.id, name: trip.name, at: Date.now() });
  LS.set('enbbang:recent', list.slice(0, 20));
}
export function recentTrips() { return LS.get('enbbang:recent', []); }

// ───────────────────────── 오프라인 (비행기·해외 데이터 끊김) ─────────────────────────
// ① 마지막으로 불러온 여행방을 기기에 저장해 두고(enbbang:cache:<id>) 연결이 없으면 그걸 보여 준다
// ② 연결이 없을 때 넣은 지출·수정은 대기열(enbbang:outbox)에 쌓았다가 연결되면 순서대로 보낸다
//    대기 중인 지출은 임시 id(tmp_…)를 쓰고, 서버에는 cid로 보내 같은 지출이 두 번 들어가지 않게 한다
export const isNetError = (e) => !navigator.onLine || /fetch|network|load failed|timeout/i.test(e?.message || String(e || ''));
const OUTBOX = 'enbbang:outbox';
const outbox = {
  all: () => LS.get(OUTBOX, []),
  save(list) {
    LS.set(OUTBOX, list);
    dispatchEvent(new CustomEvent('enbbang:outbox'));
  },
  push(op) { outbox.save([...outbox.all(), { key: uid(8), at: new Date().toISOString(), ...op }]); },
};
export const pendingCount = (tripId) => outbox.all().filter((o) => o.tripId === tripId && !(o.type === 'add' && o.exp.deletedAt)).length;

// 서버에서 받은 여행방 + 아직 못 보낸 변경 = 화면에 보일 여행방
function withOutbox(t) {
  const ops = outbox.all().filter((o) => o.tripId === t.id);
  if (!ops.length) return t;
  const exps = t.expenses.map((e) => ({ ...e }));
  for (const o of ops) {
    if (o.type === 'add') exps.push({ ...o.exp, id: o.cid, device: o.device, createdAt: o.at, deletedAt: o.exp.deletedAt || null, pending: true });
    else {
      const e = exps.find((x) => x.id === o.eid);
      if (e) Object.assign(e, o.args.p_patch, { pending: true });
    }
  }
  return { ...t, expenses: exps };
}
function cacheTrip(t) {
  LS.set(`enbbang:cache:${t.id}`, t);
  // 최근 목록(20개)에 없는 방의 저장본은 지운다 — 기기 저장 공간 보호
  const keep = new Set(recentTrips().map((x) => x.id));
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('enbbang:cache:') && !keep.has(k.slice(14))) localStorage.removeItem(k);
    }
  } catch { /* 무시 */ }
}

// ───────────────────────── LocalStore ─────────────────────────
export class LocalStore {
  mode = 'local';
  #subs = new Map();

  #load(id) {
    const t = LS.get(`enbbang:trip:${id}`);
    if (!t) throw new Error('여행방을 찾을 수 없어요');
    return t;
  }
  #save(t) {
    LS.set(`enbbang:trip:${t.id}`, t);
    rememberTrip(t);
    (this.#subs.get(t.id) || []).forEach((cb) => cb());
  }

  async createTrip({ name, baseCurrency, names }) {
    const id = uid(16);
    const t = {
      id, name, baseCurrency, createdAt: new Date().toISOString(), settledAt: null, settleMode: 'min',
      participants: names.map((n) => ({ id: uid(8), name: n, payInfo: {}, joinedAt: null })),
      expenses: [],
    };
    me.setAdminKey(id, 'local');
    this.#save(t);
    return t;
  }
  async getTrip(id) { const t = this.#load(id); rememberTrip(t); return tidyTrip(t); }
  async importSnapshot(t) {
    // 스냅샷은 같은 id를 쓰되, 이미 있으면 덮어쓴다 (가장 최근 링크가 정답)
    me.setAdminKey(t.id, me.adminKey(t.id) || 'local');
    this.#save(t);
    return t;
  }
  async addParticipant(id, name) {
    const t = this.#load(id);
    const p = { id: uid(8), name, payInfo: {}, joinedAt: null };
    t.participants.push(p);
    this.#save(t);
    return p;
  }
  async updateParticipant(id, pid, patch) {
    const t = this.#load(id);
    Object.assign(t.participants.find((p) => p.id === pid), patch);
    this.#save(t);
  }
  async addExpense(id, exp) {
    const t = this.#load(id);
    const e = { ...exp, id: uid(10), device: deviceId(), createdAt: new Date().toISOString(), deletedAt: null };
    t.expenses.push(e);
    this.#save(t);
    return e;
  }
  async updateExpense(id, eid, patch) {
    const t = this.#load(id);
    Object.assign(t.expenses.find((e) => e.id === eid), patch);
    this.#save(t);
  }
  async deleteExpense(id, eid) { return this.updateExpense(id, eid, { deletedAt: new Date().toISOString() }); }
  async markSettled(id, on = true) {
    const t = this.#load(id);
    t.settledAt = on ? new Date().toISOString() : null;
    this.#save(t);
  }
  async claimParticipant(id, pid) {
    const t = this.#load(id);
    const p = t.participants.find((x) => x.id === pid);
    if (p && !p.joinedAt) { p.joinedAt = new Date().toISOString(); this.#save(t); }
  }
  async setSettleMode(id, mode) {
    const t = this.#load(id);
    t.settleMode = mode;
    this.#save(t);
  }
  // 로컬 모드는 사진을 data URL로 지출에 그대로 담는다 (서버 없음)
  async uploadReceipt(id, blob) {
    return new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(blob);
    });
  }
  async receiptUrl(path) { return path; }
  async logEvent() { /* 로컬 모드는 지표를 모으지 않는다 */ }
  subscribe(id, cb, onStatus) {
    onStatus?.('SUBSCRIBED');
    const arr = this.#subs.get(id) || [];
    arr.push(cb);
    this.#subs.set(id, arr);
    const onStorage = (e) => { if (e.key === `enbbang:trip:${id}`) cb(); };
    addEventListener('storage', onStorage);
    return () => {
      this.#subs.set(id, (this.#subs.get(id) || []).filter((f) => f !== cb));
      removeEventListener('storage', onStorage);
    };
  }
}

// ───────────────────────── CloudStore (Supabase) ─────────────────────────
// 테이블 직접 접근은 RLS로 전부 막고, security definer RPC만 anon에 열어 둔다.
// 방 id(16자 무작위)를 아는 사람만 그 방을 읽고 쓸 수 있다 = "링크가 곧 권한".
// 실시간은 Realtime broadcast로 "바뀜" 신호만 보내고 받은 쪽이 RPC로 다시 읽는다.
export class CloudStore {
  mode = 'cloud';
  #sb;
  #channels = new Map();

  constructor(supabase) { this.#sb = supabase; }

  async #rpc(fn, args) {
    const { data, error } = await this.#sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  }
  #ping(id) {
    const ch = this.#channels.get(id);
    if (ch) ch.send({ type: 'broadcast', event: 'changed', payload: { by: deviceId() } });
  }

  async createTrip({ name, baseCurrency, names }) {
    const r = await this.#rpc('enb_create_trip', {
      p_name: name, p_base: baseCurrency, p_names: names, p_device: deviceId(),
    });
    me.setAdminKey(r.id, r.admin_key);
    const t = await this.getTrip(r.id);
    return t;
  }
  async getTrip(id) {
    let t;
    try {
      await this.flush();
      // p_device: 서버가 "내 지출인지(mine)"만 알려 준다 — 남의 기기 값은 받지 않는다 (007)
      t = await this.#rpc('enb_get_trip', { p_trip: id, p_device: deviceId() });
    } catch (e) {
      const cached = isNetError(e) && LS.get(`enbbang:cache:${id}`);
      if (!cached) throw e;
      return tidyTrip(withOutbox({ ...cached, offline: true }));
    }
    if (!t) throw new Error('여행방을 찾을 수 없어요');
    rememberTrip(t);
    cacheTrip(t);
    return tidyTrip(withOutbox(t));
  }
  async addParticipant(id, name) {
    const p = await this.#rpc('enb_add_participant', { p_trip: id, p_name: name });
    this.#ping(id);
    return p;
  }
  // 이름·송금 정보는 그 참여자를 고른 기기나 총무만 바꿀 수 있다 (서버가 확인, 007)
  async updateParticipant(id, pid, patch) {
    await this.#rpc('enb_update_participant', {
      p_trip: id, p_pid: pid, p_patch: patch, p_device: deviceId(), p_admin: me.adminKey(id) || '',
    });
    this.#ping(id);
  }
  async addExpense(id, exp) {
    // cid: 응답만 끊겨 서버엔 이미 들어간 경우 다시 보내도 한 건만 남게 하는 표시
    // 송금 "보냈어요"는 같은 송금이면 같은 표시(transferKey)를 쓴다 — 두 사람이 눌러도 한 건만 남게(009)
    const cid = exp.cid || `tmp_${uid(10)}`;
    const body = { ...exp, cid };
    // 앞서 못 보낸 게 있으면 순서를 지키려고 이것도 대기열 뒤에 붙인다
    if (!outbox.all().length) {
      try {
        const e = await this.#rpc('enb_add_expense', { p_trip: id, p_exp: body, p_device: deviceId() });
        this.#ping(id);
        return e;
      } catch (err) { if (!isNetError(err)) throw err; }
    }
    outbox.push({ type: 'add', tripId: id, cid, exp: body, device: deviceId() });
    this.flush();
    return { id: cid, pending: true };
  }
  async updateExpense(id, eid, patch) {
    eid = this.#idMap.get(eid) || eid;
    if (eid.startsWith('tmp_')) { // 아직 서버에 없는 지출 → 대기 중인 추가 자체를 고친다 (지우기·되살리기 포함)
      const list = outbox.all();
      const op = list.find((o) => o.type === 'add' && o.cid === eid);
      if (op) { Object.assign(op.exp, patch); outbox.save(list); return; }
    }
    const args = { p_trip: id, p_eid: eid, p_patch: patch, p_device: deviceId(), p_admin: me.adminKey(id) || '' };
    if (!outbox.all().length) {
      try {
        await this.#rpc('enb_update_expense', args);
        this.#ping(id);
        return;
      } catch (err) { if (!isNetError(err)) throw err; }
    }
    outbox.push({ type: 'update', tripId: id, eid, args });
    this.flush();
  }
  // 대기열 보내기 — 연결이 없으면 바로 멈추고, 서버가 거절한 건(방 삭제 등)은 버린다
  #idMap = new Map(); // 임시 id → 서버 id (보낸 뒤 화면이 새로 고쳐지기 전에 수정하는 경우)
  #flushing = null;
  flush() {
    // 이미 보내는 중이면 그게 끝난 뒤 한 번 더 (그 사이 연결이 돌아왔을 수 있다)
    if (this.#flushing) return this.#flushing.then(() => this.flush());
    this.#flushing = (async () => {
      let done = 0, failed = 0;
      const touched = new Set();
      for (let op; (op = outbox.all()[0]);) {
        try {
          if (op.type === 'add') {
            if (!op.exp.deletedAt) {
              const r = await this.#rpc('enb_add_expense', { p_trip: op.tripId, p_exp: op.exp, p_device: op.device });
              if (r?.id) this.#idMap.set(op.cid, r.id);
              done++;
            }
          } else {
            await this.#rpc('enb_update_expense', { ...op.args, p_eid: this.#idMap.get(op.eid) || op.eid });
            done++;
          }
        } catch (e) {
          if (isNetError(e)) break;
          failed++;
        }
        outbox.save(outbox.all().filter((o) => o.key !== op.key));
        touched.add(op.tripId);
      }
      touched.forEach((id) => this.#ping(id));
      if (done || failed) dispatchEvent(new CustomEvent('enbbang:flushed', { detail: { done, failed } }));
      return { done, failed };
    })().finally(() => { this.#flushing = null; });
    return this.#flushing;
  }
  async deleteExpense(id, eid) { return this.updateExpense(id, eid, { deletedAt: new Date().toISOString() }); }
  async markSettled(id, on = true) {
    await this.#rpc('enb_mark_settled', { p_trip: id, p_on: on, p_admin: me.adminKey(id) || '' });
    this.#ping(id);
  }
  // 영수증: 비공개 버킷 receipts/<방id>/<무작위>.jpg — 방 id를 아는 사람만 올리고 볼 수 있다
  #signed = new Map();
  async uploadReceipt(id, blob) {
    const path = `${id}/${uid(14)}.jpg`;
    const { error } = await this.#sb.storage.from('receipts').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (error) throw new Error(error.message);
    return path;
  }
  // 영수증 주소: Edge Function `media`가 여행방을 확인하고 1시간짜리 서명 주소를 준다.
  // (Storage 읽기를 공개 키에 열어 두면 버킷 목록 = 방 id가 밖에서 보여서 막았다 — 10/6)
  async receiptUrl(path) {
    const hit = this.#signed.get(path);
    if (hit && hit.exp > Date.now()) return hit.url;
    const { data, error } = await this.#sb.functions.invoke('media', {
      body: { bucket: 'receipts', scope: path.split('/')[0], paths: [path] },
    });
    const url = data?.urls?.[path];
    if (error || !url) throw new Error('영수증 사진을 불러오지 못했어요');
    this.#signed.set(path, { url, exp: Date.now() + 50 * 60 * 1000 });
    return url;
  }
  // 다른 기기에서 이어서 쓰기: 옛 기기의 '주인' 표시를 이 기기로 (008)
  async moveDevice(id, oldDevice) {
    if (!oldDevice || oldDevice === deviceId()) return 0;
    const n = await this.#rpc('enb_move_device', { p_trip: id, p_old: oldDevice, p_new: deviceId() });
    this.#ping(id);
    return n;
  }
  // 참여자 정리 (총무만, 008)
  async mergeParticipants(id, from, into) {
    await this.#rpc('enb_merge_participants', { p_trip: id, p_from: from, p_into: into, p_admin: me.adminKey(id) || '' });
    this.#ping(id);
  }
  async removeParticipant(id, pid) {
    await this.#rpc('enb_remove_participant', { p_trip: id, p_pid: pid, p_admin: me.adminKey(id) || '' });
    this.#ping(id);
  }
  async claimParticipant(id, pid) {
    await this.#rpc('enb_claim_participant', { p_trip: id, p_pid: pid, p_device: deviceId() });
    this.#ping(id);
  }
  async setSettleMode(id, mode) {
    await this.#rpc('enb_set_settle_mode', { p_trip: id, p_mode: mode, p_device: deviceId() });
    this.#ping(id);
  }
  async logEvent(id, type, meta = {}) {
    try { await this.#rpc('enb_log_event', { p_trip: id, p_type: type, p_device: deviceId(), p_meta: meta }); }
    catch { /* 지표 실패가 사용을 막으면 안 된다 */ }
  }
  // onStatus: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' — 끊김 표시용
  subscribe(id, cb, onStatus) {
    const ch = this.#sb.channel(`enb:${id}`, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'changed' }, () => cb()).subscribe((status) => onStatus?.(status));
    this.#channels.set(id, ch);
    return () => { this.#sb.removeChannel(ch); this.#channels.delete(id); };
  }
}

export async function createStore(config) {
  if (config?.supabaseUrl && config?.supabaseAnonKey) {
    try {
      // 앱은 js/supabase.js(빌드 때 내장)가 window.supabase를 만든다 → 비행기 모드로 켜도 서버 클라이언트가 생긴다
      const { createClient } = window.supabase?.createClient ? window.supabase
        : await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      return new CloudStore(createClient(config.supabaseUrl, config.supabaseAnonKey));
    } catch (e) {
      console.warn('Supabase 연결 실패 — 로컬 모드로 동작', e);
    }
  }
  return new LocalStore();
}
