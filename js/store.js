// 저장소 계층 — LocalStore(설정 없이 바로 동작) / CloudStore(Supabase, 링크 공유·실시간·지표)
// 두 저장소는 같은 메서드와 같은 trip 객체 모양을 쓴다.
//
// trip = { id, name, baseCurrency, createdAt, settledAt,
//          participants: [{ id, name, payInfo: { toss, kakao, account } }],
//          expenses: [{ id, title, date, amount, currency, rate, baseOverride,
//                       payerId, shares: [{ pid, w }], device, createdAt, deletedAt }] }

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
      id, name, baseCurrency, createdAt: new Date().toISOString(), settledAt: null,
      participants: names.map((n) => ({ id: uid(8), name: n, payInfo: {} })),
      expenses: [],
    };
    me.setAdminKey(id, 'local');
    this.#save(t);
    return t;
  }
  async getTrip(id) { const t = this.#load(id); rememberTrip(t); return t; }
  async importSnapshot(t) {
    // 스냅샷은 같은 id를 쓰되, 이미 있으면 덮어쓴다 (가장 최근 링크가 정답)
    me.setAdminKey(t.id, me.adminKey(t.id) || 'local');
    this.#save(t);
    return t;
  }
  async addParticipant(id, name) {
    const t = this.#load(id);
    const p = { id: uid(8), name, payInfo: {} };
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
  async logEvent() { /* 로컬 모드는 지표를 모으지 않는다 */ }
  subscribe(id, cb) {
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
    const t = await this.#rpc('enb_get_trip', { p_trip: id });
    if (!t) throw new Error('여행방을 찾을 수 없어요');
    rememberTrip(t);
    return t;
  }
  async addParticipant(id, name) {
    const p = await this.#rpc('enb_add_participant', { p_trip: id, p_name: name });
    this.#ping(id);
    return p;
  }
  async updateParticipant(id, pid, patch) {
    await this.#rpc('enb_update_participant', { p_trip: id, p_pid: pid, p_patch: patch });
    this.#ping(id);
  }
  async addExpense(id, exp) {
    const e = await this.#rpc('enb_add_expense', { p_trip: id, p_exp: exp, p_device: deviceId() });
    this.#ping(id);
    return e;
  }
  async updateExpense(id, eid, patch) {
    await this.#rpc('enb_update_expense', {
      p_trip: id, p_eid: eid, p_patch: patch, p_device: deviceId(), p_admin: me.adminKey(id) || '',
    });
    this.#ping(id);
  }
  async deleteExpense(id, eid) { return this.updateExpense(id, eid, { deletedAt: new Date().toISOString() }); }
  async markSettled(id, on = true) {
    await this.#rpc('enb_mark_settled', { p_trip: id, p_on: on, p_admin: me.adminKey(id) || '' });
    this.#ping(id);
  }
  async logEvent(id, type, meta = {}) {
    try { await this.#rpc('enb_log_event', { p_trip: id, p_type: type, p_device: deviceId(), p_meta: meta }); }
    catch { /* 지표 실패가 사용을 막으면 안 된다 */ }
  }
  subscribe(id, cb) {
    const ch = this.#sb.channel(`enb:${id}`, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'changed' }, () => cb()).subscribe();
    this.#channels.set(id, ch);
    return () => { this.#sb.removeChannel(ch); this.#channels.delete(id); };
  }
}

export async function createStore(config) {
  if (config?.supabaseUrl && config?.supabaseAnonKey) {
    try {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      return new CloudStore(createClient(config.supabaseUrl, config.supabaseAnonKey));
    } catch (e) {
      console.warn('Supabase 연결 실패 — 로컬 모드로 동작', e);
    }
  }
  return new LocalStore();
}
