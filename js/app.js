// 엔빵 웹 베타 — 화면 로직 (프레임워크 없음, 해시 라우팅)
import {
  settle, expenseBaseMinor, decimalsOf, splitMinor, toMinor, fromMinor, CATEGORIES, guessCategory, categoryTotals,
  transferKey, brokenExpenses, guessCurrency,
} from './settle.js?v=202610071636';
import { createStore, me, recentTrips, deviceId, pendingCount } from './store.js?v=202610071636';
import { getRate, RATE_ATTRIBUTION } from './rates.js?v=202610071636';
import {
  encodeSnapshot, decodeSnapshot, fmt, fmtMajor, settlementText, settlementImage, transferLinks, reminderText, friendly,
} from './share.js?v=202610071636';
import {
  isApp, SITE, nativeShare, nativeShareImage, haptic, feedback, scheduleReminder, initNative,
  getSettings, setSetting, applyTheme, pickPhoto, compressImage, askReview,
} from './native.js?v=202610071636';

const CURRENCIES = ['KRW', 'JPY', 'USD', 'EUR', 'TWD', 'VND', 'THB', 'PHP', 'CNY', 'HKD', 'SGD', 'GBP', 'AUD',
  'IDR', 'MYR', 'CAD', 'CHF', 'NZD'];
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');

let store;
let view = { tripId: null, trip: null, tab: 'list', q: '', unsub: null };

// ───────── 유틸 ─────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('sv-SE');
const parseAmount = (s) => Number(String(s).replace(/[,\s]/g, ''));

// action = { label, run } 이면 버튼을 달고 5초 보여준다 (되돌리기 등)
function toast(msg, action) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) {
    t.querySelector('button').onclick = () => { t.classList.remove('on'); action.run(); };
  }
  t.classList.toggle('has-action', !!action);
  t.classList.add('on');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('on'), action ? 5000 : 2200);
}

// 지운 지출 되살리기 (지운 사람이 5초 안에 "되돌리기"를 누른 경우)
async function restoreExpense(tripId, eid, msg) {
  try { await store.updateExpense(tripId, eid, { deletedAt: null }); await refreshTrip(); toast(msg); }
  catch (err) { report(err); }
}

async function copy(text, msg = '복사했어요') {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(msg);
  }
}

// ───────── 연결 상태 막대 — 저장 실패를 조용히 넘기지 않는다 ─────────
const net = { reason: null };
function showNet(reason, msg, action) {
  net.reason = reason;
  const bar = document.getElementById('netbar');
  bar.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="btn sm">${esc(action.label)}</button>` : ''}`;
  if (action) bar.querySelector('button').onclick = action.run;
  bar.hidden = false;
}
function hideNet(reason) {
  if (reason && net.reason !== reason) return;
  net.reason = null;
  document.getElementById('netbar').hidden = true;
}
const isNetErr = (e) => !navigator.onLine || /fetch|network|load failed|timeout/i.test(e?.message || '');

// 저장 실패 처리: 네트워크 문제면 막대로 크게 알리고(시트는 열린 채라 다시 누르면 됨), 그 외는 토스트
function report(err) {
  if (isNetErr(err)) showNet('save', '저장하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.');
  else toast(friendly(err));
}

async function refreshTrip() {
  if (!view.tripId) return;
  try { view.trip = await store.getTrip(view.tripId); renderTrip(); hideNet('save'); } catch { /* 다음 기회에 */ }
}

// 오프라인: 지출은 그대로 넣으면 기기에 쌓였다가 연결되면 저장된다 (store.js 대기열)
function updateOfflineBar() {
  const n = view.tripId && store?.mode === 'cloud' ? pendingCount(view.tripId) : 0;
  if (n) showNet('offline', `오프라인 · 지출 ${n}건은 연결되면 자동으로 저장돼요`);
  else if (!navigator.onLine || view.trip?.offline) showNet('offline', '오프라인이에요. 지출은 그대로 넣으면 연결될 때 저장돼요.');
  else hideNet('offline');
}
addEventListener('offline', updateOfflineBar);
addEventListener('online', () => { updateOfflineBar(); store?.flush?.(); refreshTrip(); });
addEventListener('enbbang:outbox', updateOfflineBar);
addEventListener('enbbang:flushed', (e) => {
  const { done, failed } = e.detail;
  if (failed) toast(`지출 ${failed}건은 저장하지 못했어요. 다시 넣어 주세요`);
  else if (done) toast(`연결돼서 지출 ${done}건을 저장했어요`);
  refreshTrip();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  Promise.resolve(store?.flush?.()).finally(() => refreshTrip());
});

// 환율 입력 단위 — 엔은 10엔, 동·루피아·원은 1,000 기준으로 받는다 (사용자 결정 10/6: "10엔 = 91원").
// 저장은 늘 1단위 환율이라 정산 계산·서버는 그대로다.
const RATE_UNIT = { JPY: 10, VND: 1000, IDR: 1000, KRW: 1000 };
const rateUnit = (c) => RATE_UNIT[c] || 1;
// 화면에 보이는 환율: 1 이상이면 소수 둘째 자리까지, 작으면 유효숫자 4자리
const tidy = (x) => (Number(x) >= 1 ? Math.round(Number(x) * 100) / 100 : Number(Number(x).toPrecision(4)));

function nameOf(trip, pid) { return trip.participants.find((p) => p.id === pid)?.name ?? '?'; }
const isAdmin = (trip) => !!me.adminKey(trip.id);

// ───────── 라우터 ─────────
async function route() {
  const h = location.hash.slice(1);
  // 같은 여행방 안에서 탭만 바꾸는 경우 — 다시 불러오거나 실시간 연결을 새로 맺지 않는다 (10/7)
  const same = h.match(/^\/t\/([\w-]+)(?:\/(settle|people))?$/);
  if (same && view.trip && view.unsub && view.tripId === same[1]) {
    closeSheet();
    const tab = same[2] || 'list';
    if (tab !== view.tab) {
      view.tab = tab;
      renderTrip();
      if (tab === 'settle') store.logEvent(view.tripId, 'settle_viewed');
    }
    return;
  }
  if (view.unsub) { view.unsub(); view.unsub = null; }
  closeSheet();
  // 웹에서 주소만 열면 소개 페이지 (본문은 index.html에 정적으로). #/… 링크와 앱은 바로 앱 화면, #/start = 방 만들기
  const landing = !isApp && !h.startsWith('/');
  const wasLanding = document.documentElement.classList.contains('landing');
  document.documentElement.classList.toggle('landing', landing);
  if (landing) return renderLanding();
  if (wasLanding) scrollTo(0, 0);
  let m;
  if ((m = h.match(/^\/t\/([\w-]+)\/mv\/([\w-]+)$/))) return importMove(m[1], m[2]);
  if ((m = h.match(/^\/t\/([\w-]+)(?:\/(\w+))?/))) return openTrip(m[1], m[2] || 'list');
  if ((m = h.match(/^\/s\/(.+)$/))) return importSnapshot(m[1]);
  renderHome();
}

// ───────── 소개 페이지 (웹) ─────────
// 최근 여행방 바로가기와 스토어 버튼만 채운다
function renderLanding() {
  view = { ...view, tripId: null, trip: null };
  const recent = recentTrips();
  const $r = document.getElementById('lp-recent');
  if ($r && recent.length) {
    $r.innerHTML = `최근 여행방: ${recent.slice(0, 3).map((t) => `<a href="#/t/${esc(t.id)}">${esc(t.name)}</a>`).join(' · ')}`;
    $r.hidden = false;
  }
  const st = window.ENBBANG_CONFIG?.stores || {};
  const $s = document.getElementById('lp-store');
  if ($s && (st.android || st.ios)) {
    $s.innerHTML = [st.android && `<a class="btn" href="${esc(st.android)}" rel="noopener">Google Play에서 받기</a>`,
      st.ios && `<a class="btn" href="${esc(st.ios)}" rel="noopener">App Store에서 받기</a>`].filter(Boolean).join('');
    $s.classList.add('has-links');
  }
  initLandingCalc();
}

// 첫 화면 계산기 — 예시 지출(엔화) 켜고 끄기 + 직접 더하기 + 인원 → 1인당 원화. 환율은 앱과 같은 참고 환율(실패하면 예시 값)
const LP_FALLBACK = { KRW: 1, JPY: 9.1, USD: 1390, EUR: 1610, TWD: 43, VND: 0.054, THB: 39, PHP: 24, CNY: 192, HKD: 178, SGD: 1070, GBP: 1850, AUD: 900,
  IDR: 0.085, MYR: 310, CAD: 1000, CHF: 1700, NZD: 820 };
let lpCalcBound = false;
// 환율 날짜 "06 Oct 2026" → "10/6"
const lpDate = (s) => { const d = new Date(s); return isNaN(d) ? s : `${d.getMonth() + 1}/${d.getDate()}`; };
function initLandingCalc() {
  const $f = document.getElementById('lp-calc');
  if (!$f || lpCalcBound) return;
  lpCalcBound = true;
  const st = { people: 4, live: {}, date: null };
  const $extra = $f.querySelector('#lp-extra');
  const $cur = $f.querySelector('#lp-cur');
  const won = (n) => Math.round(n).toLocaleString('ko-KR');
  const rateOf = (c) => st.live[c] ?? LP_FALLBACK[c] ?? 1;
  const draw = () => {
    let total = 0;
    $f.querySelectorAll('.lp-item input').forEach((cb) => {
      cb.closest('.lp-item').classList.toggle('off', !cb.checked);
      if (cb.checked) total += Number(cb.dataset.yen) * rateOf('JPY');
    });
    const cur = $cur.value;
    total += (Number($extra.value.replace(/[^0-9]/g, '')) || 0) * rateOf(cur);
    $f.querySelector('#lp-total').textContent = won(Math.round(total / 10) * 10);
    $f.querySelector('#lp-per').textContent = won(Math.round(total / st.people / 10) * 10);
    $f.querySelector('#lp-people').textContent = `${st.people}명`;
    $f.querySelector('#lp-dec').disabled = st.people <= 2;
    $f.querySelector('#lp-inc').disabled = st.people >= 20;
    const c = cur === 'KRW' ? 'JPY' : cur;
    const unit = rateUnit(c);
    const live = st.live[c] != null;
    $f.querySelector('#lp-rate').innerHTML = `${live ? '참고 환율' : '예시 환율'} ${unit.toLocaleString('ko-KR')} ${c} = ${won(rateOf(c) * unit)}원`
      + (live && st.date ? ` (${esc(lpDate(st.date))} 기준)` : '')
      + ' · 여행방에서는 참고 환율이 자동으로 채워지고, 카드에 찍힌 원화로 고칠 수 있어요.'
      + (live ? ` <a href="${RATE_ATTRIBUTION.href}" target="_blank" rel="noopener">${esc(RATE_ATTRIBUTION.text)}</a>` : '');
  };
  const fetchRate = async (c) => {
    if (c === 'KRW' || st.live[c] != null) return;
    const r = await getRate(c, 'KRW').catch(() => null);
    if (r?.rate) { st.live[c] = r.rate; st.date = r.date || st.date; draw(); }
  };
  $f.addEventListener('submit', (e) => e.preventDefault());
  $f.addEventListener('change', draw);
  $extra.addEventListener('input', () => {
    const n = $extra.value.replace(/[^0-9]/g, '').slice(0, 9);
    $extra.value = n ? Number(n).toLocaleString('ko-KR') : '';
    draw();
  });
  $cur.addEventListener('change', () => fetchRate($cur.value));
  $f.querySelector('#lp-dec').addEventListener('click', () => { st.people = Math.max(2, st.people - 1); draw(); });
  $f.querySelector('#lp-inc').addEventListener('click', () => { st.people = Math.min(20, st.people + 1); draw(); });
  draw();
  fetchRate('JPY');
}

// ───────── 홈 ─────────
function renderHome() {
  view = { ...view, tripId: null, trip: null };
  const recent = recentTrips();
  $app.innerHTML = `
    <div class="hero">
      <div class="row between"><span class="brand"><i>N</i>트립N빵</span>
        <span class="row"><span class="badge">${store.mode === 'cloud' ? '베타' : '로컬 모드'}</span>${GEAR}</span></div>
      <h1>여행 정산,<br>링크 하나로 끝.</h1>
      <p>같이 쓴 돈을 다 같이 적으면, 누가 누구에게 얼마 보낼지 <b>최소 송금</b>으로 정리해 드려요.</p>
    </div>
    <ol class="steps">
      <li><b>방 만들기</b><span>여행 이름과 멤버</span></li>
      <li><b>링크 보내기</b><span>카톡 단톡방에</span></li>
      <li><b>쓴 돈 적기</b><span>정산표는 자동</span></li>
    </ol>
    <form class="card stack" id="create">
      <label class="field"><span>여행 이름</span>
        <input class="input" name="name" maxlength="60" placeholder="예: 10월 오사카 3박4일" required></label>
      <div class="field"><span>함께 가는 사람</span>
        <div class="chips members" id="members"></div>
        <div class="row" style="margin-top:8px">
          <input class="input grow" id="mname" maxlength="30" placeholder="내 이름부터 입력" enterkeyhint="done" autocomplete="off">
          <button type="button" class="btn" id="madd">＋ 추가</button>
        </div></div>
      <label class="field"><span>정산 통화</span>
        <select class="input" name="base">${CURRENCIES.map((c) => `<option ${c === 'KRW' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <button class="btn primary block">여행방 만들기</button>
    </form>
    ${recent.length ? `<div class="card recent" style="margin-top:16px"><b>최근 여행방</b>
      ${recent.map((t) => `<a href="#/t/${esc(t.id)}"><span>${esc(t.name)}</span><span class="muted small">${new Date(t.at).toLocaleDateString('ko-KR')}</span></a>`).join('')}</div>` : ''}
    <p class="muted small prep">✈️ 출발 전 입국 서류·eSIM·환전 정리는 <a href="https://blog.naver.com/solo_os" target="_blank" rel="noopener" data-prep>여행 실무 노트</a>에서 볼 수 있어요 (운영자 블로그)</p>
    <p class="muted small" style="margin-top:24px">${store.mode === 'cloud'
      ? '링크를 받은 사람은 누구나 이 방을 보고 입력할 수 있어요. 방은 마지막 사용 후 90일 뒤 정리돼요.'
      : '로컬 모드: 이 기기에만 저장돼요. 공유 링크에는 그 시점의 내용이 담겨요.'}
      · <a href="privacy.html">개인정보처리방침</a></p>`;

  // 멤버 칩 입력: 이름 하나씩 추가(쉼표로 여러 명 붙여 넣어도 됨), ×로 빼기, 첫 번째가 "나"
  const members = [];
  const mInput = $app.querySelector('#mname');
  const renderMembers = () => {
    $app.querySelector('#members').innerHTML = members.map((n, i) =>
      `<span class="chip member-chip">${esc(n)}${i === 0 ? ' <small>나</small>' : ''}<button type="button" data-rm="${i}" aria-label="${esc(n)} 빼기">×</button></span>`).join('');
    $app.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = () => { members.splice(+b.dataset.rm, 1); renderMembers(); };
    });
    mInput.placeholder = members.length ? '함께 가는 사람 이름' : '내 이름부터 입력';
  };
  const addMembers = () => {
    const names = mInput.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      if (members.includes(n)) { toast(`${n}님은 이미 있어요`); continue; }
      if (members.length >= 30) { toast('최대 30명까지예요'); break; }
      members.push(n.slice(0, 30));
    }
    mInput.value = '';
    renderMembers();
    mInput.focus();
  };
  $app.querySelector('#madd').onclick = addMembers;
  mInput.onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); addMembers(); }
  };
  // '같은 멤버로 새 여행방'으로 왔으면 이름·정산 통화를 채워 둔다
  let prefill = null;
  try { prefill = JSON.parse(sessionStorage.getItem('enbbang:prefill') || 'null'); sessionStorage.removeItem('enbbang:prefill'); } catch { /* 무시 */ }
  if (prefill?.names?.length) {
    members.push(...prefill.names.slice(0, 30));
    if (CURRENCIES.includes(prefill.base)) $app.querySelector('#create').base.value = prefill.base;
    setTimeout(() => $app.querySelector('#create').name.focus(), 50);
    toast(`지난 여행 멤버 ${prefill.names.length}명을 채워 뒀어요`);
  }
  renderMembers();
  $app.querySelector('[data-prep]')?.addEventListener('click', () => store.logEvent(null, 'prep_link'));

  $app.querySelector('#create').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (mInput.value.trim()) addMembers(); // 입력해 두고 추가를 안 누른 이름도 챙긴다
    const names = [...members];
    if (!names.length) { mInput.focus(); return toast('함께 가는 사람을 적어 주세요'); }
    if (names.length > 30) return toast('최대 30명까지예요');
    e.target.querySelector('button').disabled = true;
    try {
      const t = await store.createTrip({ name: String(f.get('name')).trim(), baseCurrency: f.get('base'), names });
      me.set(t.id, t.participants[0].id);
      store.claimParticipant(t.id, t.participants[0].id).catch(() => {});
      sessionStorage.setItem(`fresh:${t.id}`, '1'); // 방금 만든 방 → 초대 카드를 크게
      store.logEvent(t.id, 'trip_source', firstTouch()); // 어디서 와서 방을 만들었나 (블로그·쇼츠·인스타 utm)
      location.hash = `#/t/${t.id}`;
    } catch (err) { report(err); e.target.querySelector('button').disabled = false; }
  };
}

// ───────── 스냅샷 가져오기 (로컬 모드 공유) ─────────
async function importSnapshot(data) {
  try {
    const t = await decodeSnapshot(data);
    if (!t?.id || !Array.isArray(t.participants)) throw new Error('bad');
    if (store.mode === 'local') await store.importSnapshot(t);
    replaceHash(`#/t/${t.id}`);
  } catch {
    $app.innerHTML = `<div class="empty">링크가 손상됐어요. 보낸 사람에게 다시 받아 주세요.<br><br><a href="#/">처음으로</a></div>`;
  }
}

// ───────── 여행방 ─────────
async function openTrip(id, tab) {
  view.tab = tab;
  if (view.tripId !== id) view.q = '';
  view.tripId = id;
  try {
    view.trip = await store.getTrip(id);
  } catch (e) {
    // 못 불러왔을 때 — 무엇이 문제인지 한국어로, 다시 시도 버튼
    $app.innerHTML = `<div class="empty err-screen" role="alert"><p>${esc(friendly(e))}</p>
      <button class="btn primary" id="retry">다시 시도</button><p><a href="#/">처음으로</a></p></div>`;
    $app.querySelector('#retry').onclick = () => route();
    return;
  }
  let wasDown = false;
  view.unsub = store.subscribe(id, refreshTrip, (status) => {
    if (status === 'SUBSCRIBED') {
      hideNet('realtime');
      if (wasDown) refreshTrip(); // 끊긴 사이 바뀐 내용 따라잡기
      wasDown = false;
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      wasDown = true;
      showNet('realtime', '실시간 연결이 끊겼어요. 다른 사람이 적은 내용이 늦게 보일 수 있어요.',
        { label: '새로고침', run: () => location.reload() });
    }
  });
  if (!sessionStorage.getItem(`opened:${id}`)) {
    sessionStorage.setItem(`opened:${id}`, '1');
    store.logEvent(id, 'trip_opened');
  }
  renderTrip();
  if (!me.get(id) || !view.trip.participants.some((p) => p.id === me.get(id))) pickIdentity();
  if (tab === 'settle') store.logEvent(id, 'settle_viewed');
}

function renderTrip() {
  const t = view.trip;
  if (!t) return;
  const result = settle(t);
  const myId = me.get(t.id);
  const mine = result.balances.find((b) => b.pid === myId);
  const tabs = [['list', '지출'], ['settle', '정산'], ['people', '멤버']];

  $app.innerHTML = `
    <header class="top">
      <div class="row">
        <a class="icon-btn" href="#/" aria-label="처음으로">←</a>
        <h1 class="grow">${esc(t.name)}</h1>
        ${t.settledAt ? '<span class="badge">정산 완료</span>' : ''}
        <button class="btn sm primary" id="share">친구 초대</button>
        ${GEAR}
      </div>
      <nav class="tabs" role="tablist">${tabs.map(([k, l]) =>
        `<button role="tab" aria-selected="${view.tab === k}" data-tab="${k}">${l}</button>`).join('')}</nav>
    </header>
    <div class="summary">
      <div class="card"><span class="muted small">총 지출</span><b class="num">${fmt(result.totalSpent, t.baseCurrency)}</b></div>
      <div class="card"><span class="muted small">${!mine ? '나' : `${esc(nameOf(t, myId))}님 ${mine.net > 0 ? '받을 돈' : mine.net < 0 ? '낼 돈' : ''}`}</span>
        <b class="num ${mine?.net > 0 ? 'plus' : mine?.net < 0 ? 'minus' : ''}">${!mine ? '—'
          : mine.net ? fmt(Math.abs(mine.net), t.baseCurrency) : '정산 0원'}</b></div>
    </div>
    <main id="tab-body"></main>
    ${view.tab === 'list' ? '<button class="fab" id="add">＋ 지출</button>' : ''}`;

  $app.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => goTab(b.dataset.tab);
  });
  $app.querySelector('#share').onclick = () => shareTrip(t);
  const add = $app.querySelector('#add');
  if (add) add.onclick = () => expenseSheet();

  const body = $app.querySelector('#tab-body');
  if (view.slide) { body.classList.add(`slide-${view.slide}`); view.slide = null; } // 스와이프로 왔으면 밀려 들어오기
  if (view.tab === 'settle') renderSettle(body, t, result);
  else if (view.tab === 'people') renderPeople(body, t);
  else renderList(body, t);
  updateOfflineBar();
}

// "2026-10-06" → "10월 6일 (월) · 2일차" (여행 첫 지출 날을 1일차로, 60일 넘으면 일차는 뺀다)
const WEEK = '일월화수목금토';
function dayLabel(date, start) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return date || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  let label = `${+m[2]}월 ${+m[3]}일 (${WEEK[d.getUTCDay()]})`;
  const s = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start || '');
  if (s) {
    const n = Math.round((d - Date.UTC(+s[1], +s[2] - 1, +s[3], 12)) / 864e5) + 1;
    if (n >= 1 && n <= 60) label += ` · ${n}일차`;
  }
  return label;
}

function renderList(body, t) {
  const q = view.q.trim().toLowerCase();
  const live = t.expenses.filter((e) => !e.deletedAt);
  const spends = live.filter((e) => e.kind !== 'transfer');
  const list = live
    .filter((e) => !q || e.title.toLowerCase().includes(q) || nameOf(t, e.payerId).toLowerCase().includes(q))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const byCur = {};
  spends.forEach((e) => { byCur[e.currency] = (byCur[e.currency] || 0) + Number(e.amount); });
  const curLine = Object.keys(byCur).length > 1
    ? `<p class="muted small">통화별 합계: ${Object.entries(byCur).map(([c, v]) => fmtMajor(v, c)).join(' · ')}</p>` : '';

  let lastDay = '';
  const start = spends.map((e) => e.date).filter(Boolean).sort()[0];
  // 금액·환율·나눌 사람이 비어 계산에서 뺀 지출 — 방은 그대로 열고, 고쳐 달라고만 알린다
  const broken = new Set(brokenExpenses(t).map((e) => e.id));
  body.innerHTML = `
    ${broken.size ? `<div class="card broken-card" role="status"><b>⚠️ 정산에서 뺀 지출 ${broken.size}건</b>
      <p class="small">금액·환율·나눌 사람 중 비어 있는 게 있어요. 아래 <b>계산 제외</b> 표시된 지출을 눌러 고쳐 주세요.</p></div>` : ''}
    ${inviteCard(t, spends.length)}
    ${live.length > 4 ? `<input class="input" id="q" type="search" placeholder="검색 (내용·낸 사람)" value="${esc(view.q)}">` : ''}
    ${curLine}
    ${!spends.length ? `<div class="empty">아직 지출이 없어요.<br>아래 <b>＋ 지출</b>로 첫 항목을 넣어 보세요.</div>` : ''}
    ${list.map((e) => {
      const day = e.date !== lastDay ? `<div class="day">${esc(dayLabel(e.date, start))}</div>` : '';
      lastDay = e.date;
      if (e.kind === 'transfer') {
        return `${day}<div class="exp transfer" data-tid="${esc(e.id)}">
          <div class="grow"><div class="t">💸 ${esc(nameOf(t, e.payerId))} → ${esc(nameOf(t, e.shares[0]?.pid))} 송금${e.pending ? ' <span class="badge pending">저장 대기</span>' : ''}</div>
            <div class="muted small">보냈어요 표시 · 눌러서 취소</div></div>
          <div class="amt num muted">${fmtMajor(e.amount, e.currency)}</div></div>`;
      }
      let baseLine = '';
      if (e.currency !== t.baseCurrency) {
        try { baseLine = `<div class="muted small num">≈ ${fmt(expenseBaseMinor(e, t.baseCurrency), t.baseCurrency)}</div>`; } catch { baseLine = '<div class="minus small">환율 필요</div>'; }
      }
      const mode = splitModeOf(e.shares);
      const who = `${e.shares.length === t.participants.length ? '전원' : `${e.shares.length}명`}${mode === 'parts' ? ' · 몫대로' : mode === 'exact' ? ' · 금액 지정' : ''}`;
      const cat = CATEGORIES.find((c) => c.id === e.category) || CATEGORIES.find((c) => c.id === 'etc');
      return `${day}<div class="exp" data-eid="${esc(e.id)}">
        <span class="cat-ico" aria-label="${cat.label}">${cat.emoji}</span>
        <div class="grow"><div class="t">${esc(e.title)}${e.receipt ? ' <span class="rc-mark" aria-label="영수증 있음">🧾</span>' : ''}${e.pending ? ' <span class="badge pending">저장 대기</span>' : ''}${broken.has(e.id) ? ' <span class="badge broken">계산 제외</span>' : ''}</div>
          <div class="muted small">${esc(nameOf(t, e.payerId))} 결제 · ${who}</div></div>
        <div class="amt num">${fmtMajor(e.amount, e.currency)}${baseLine}</div></div>`;
    }).join('')}`;

  const qi = body.querySelector('#q');
  if (qi) qi.oninput = () => {
    view.q = qi.value;
    const pos = qi.selectionStart;
    renderList(body, t);
    const n = body.querySelector('#q'); n.focus(); n.setSelectionRange(pos, pos);
  };
  body.querySelectorAll('[data-eid]').forEach((el) => {
    el.onclick = () => expenseSheet(t.expenses.find((e) => e.id === el.dataset.eid));
  });
  body.querySelectorAll('[data-tid]').forEach((el) => {
    el.onclick = () => undoTransfer(t, el.dataset.tid);
  });
  bindInviteCard(body, t);
}

// 초대 카드: 방을 막 만들었거나, 아직 안 들어온 멤버가 있고 지출이 적을 때 맨 위에
function inviteCard(t, spendCount) {
  const cloud = store.mode === 'cloud';
  const waiting = cloud ? t.participants.filter((p) => !p.joinedAt) : [];
  const fresh = sessionStorage.getItem(`fresh:${t.id}`) && spendCount < 3;
  if (!fresh && !(waiting.length && spendCount < 5) && spendCount > 0) return '';
  return `<div class="card invite">
    <b>👋 친구를 초대하세요</b>
    <p class="small">링크를 단톡방에 올리면, 친구는 이름만 고르면 바로 같이 적을 수 있어요.</p>
    <div class="row"><button class="btn primary grow" id="inv-share">카톡으로 초대하기</button>
      <button class="btn ghost" id="inv-copy">링크 복사</button></div>
    ${cloud ? `<div class="joined small">${t.participants.map((p) => p.joinedAt
      ? `<span class="on">✓ ${esc(p.name)}</span>` : `<span>${esc(p.name)} 대기</span>`).join('')}</div>` : ''}
  </div>`;
}

function bindInviteCard(body, t) {
  const s = body.querySelector('#inv-share');
  if (!s) return;
  s.onclick = () => shareTrip(t);
  body.querySelector('#inv-copy').onclick = async () => {
    copy(await tripLink(t), '링크를 복사했어요. 단톡방에 붙여 넣으세요');
    store.logEvent(t.id, 'invite_shared', { via: 'copy' });
  };
}

async function undoTransfer(t, tid) {
  const e = t.expenses.find((x) => x.id === tid);
  if (!e) return;
  try {
    await store.deleteExpense(t.id, tid);
    await refreshTrip();
    toast(`${nameOf(t, e.payerId)} → ${nameOf(t, e.shares[0]?.pid)} 송금 기록을 취소했어요`,
      { label: '되돌리기', run: () => restoreExpense(t.id, tid, '송금 기록을 되살렸어요') });
  } catch (err) { report(err); }
}

function renderSettle(body, t, result) {
  const cur = t.baseCurrency;
  const { pending } = result;
  const done = result.transfers.filter((x) => x.done);
  const allDone = result.transfers.length > 0 && !pending.length;
  const modeNote = result.mode === 'direct'
    ? '지출마다 <b>낸 사람에게 바로</b> 갚아요. 송금 횟수는 늘 수 있어요.'
    : `각자 낼 총액은 같고 <b>송금 횟수만 줄였어요</b>. 그래서 같이 안 먹은 사람에게 보낼 수도 있어요.${result.optimal ? '' : ' (인원이 많아 간소화 계산)'}`;

  const row = (x) => {
    const i = result.transfers.indexOf(x);
    const links = x.done ? [] : transferLinks(t.participants.find((p) => p.id === x.to), x.amount, cur);
    return `<div class="xfer ${x.done ? 'done' : ''}">
      <span class="who">${esc(nameOf(t, x.from))}</span><span class="muted">→</span><span class="who">${esc(nameOf(t, x.to))}</span>
      <span class="amt num">${fmt(x.amount, cur)}</span>
      <div class="links">
        ${x.done
          ? `<span class="paid">✓ 보냈어요</span><button class="btn sm ghost" data-undo="${i}">취소</button>`
          : `<button class="btn sm send" data-paid="${i}">보냈어요 ✓</button>
             <button class="btn sm ghost" data-remind="${i}">🔔 리마인드</button>
             ${isApp && x.from === me.get(t.id) ? `<button class="btn sm ghost" data-alarm="${i}">⏰ 내일 알림</button>` : ''}
             <button class="btn sm ghost" data-copy-amt="${i}">금액 복사</button>
             ${links.map((l, j) => l.href
               ? `<a class="btn sm ghost" href="${esc(l.href)}" target="_blank" rel="noopener" data-paylink="${l.kind}">${l.label}${l.over ? ' (한도 30만)' : ''}</a>`
               : `<button class="btn sm ghost" data-copy-acc="${i}:${j}">${l.label}</button>`).join('')}`}
      </div>
      ${!x.done && !links.length ? `<p class="muted small hint">${esc(nameOf(t, x.to))}님이 멤버 탭에 송금 정보를 넣으면 송금 버튼이 생겨요</p>` : ''}
      ${!x.done && links.length && payChangedRecently(t, x.to) ? `<p class="small hint pay-changed">⚠️ ${esc(nameOf(t, x.to))}님 송금 정보가 최근 바뀌었어요. 보내기 전에 확인해 주세요</p>` : ''}
    </div>`;
  };

  body.innerHTML = `
    <div class="seg" role="radiogroup" aria-label="정산 방식">
      <button role="radio" aria-checked="${result.mode === 'min'}" data-mode="min">최소 송금</button>
      <button role="radio" aria-checked="${result.mode === 'direct'}" data-mode="direct">낸 사람에게 직접</button>
    </div>
    <p class="muted small mode-note">${modeNote}</p>
    ${allDone || t.settledAt ? `<div class="card celebrate"><b>🎉 정산 끝!</b><p class="small">모든 송금이 완료됐어요. 다음 여행도 같이 가나요?</p>
      <button class="btn block" id="same-new" style="margin-top:8px">👥 같은 멤버로 새 여행방</button></div>` : ''}
    ${statementCard(t)}
    <div class="card">
      <div class="row between"><b>${pending.length ? `보낼 돈 ${pending.length}건` : '보낼 돈 없음'}</b>
        ${done.length ? `<span class="muted small">완료 ${done.length}건</span>` : ''}</div>
      ${!result.transfers.length ? '<div class="empty">아직 정산할 게 없어요</div>' : ''}
      ${pending.map(row).join('')}
      ${done.map(row).join('')}
      ${pending.length > 1 ? '<button class="btn ghost block" id="remind-all" style="margin-top:12px">🔔 안 보낸 사람 모두에게 알림 복사</button>' : ''}
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary grow" id="share-text">카톡용 복사</button>
      <button class="btn grow" id="share-img">이미지로 공유</button>
    </div>
    ${catCard(t, result.totalSpent)}
    <details class="card" style="margin-top:12px"><summary>계산 근거 보기</summary>
      <div class="table-wrap"><table class="basis num"><thead><tr><th>이름</th><th>낸 돈</th><th>쓴 몫</th><th>송금</th><th>남은 차액</th></tr></thead><tbody>
      ${result.balances.map((b) => `<tr><td>${esc(nameOf(t, b.pid))}</td><td>${fmt(b.paid, cur)}</td><td>${fmt(b.owed, cur)}</td>
        <td>${[b.sent && `보냄 ${fmt(b.sent, cur)}`, b.received && `받음 ${fmt(b.received, cur)}`].filter(Boolean).join(' / ') || '—'}</td>
        <td class="${b.net > 0 ? 'plus' : b.net < 0 ? 'minus' : ''}">${b.net > 0 ? '+' : ''}${fmt(b.net, cur)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">남은 차액이 +면 받을 돈, −면 낼 돈. 외화 지출은 입력한 환율(또는 카드 청구액)로 ${cur} 환산. 나누어 떨어지지 않는 1${cur === 'KRW' ? '원' : ' 단위'}은 목록 앞사람이 냅니다.</p>
    </details>
    ${isAdmin(t) ? `<button class="btn ghost block" id="mark" style="margin-top:12px">${t.settledAt ? '정산 완료 취소' : '정산 완료로 표시'}</button>` : ''}`;

  body.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.mode === result.mode) return;
      try { await store.setSettleMode(t.id, b.dataset.mode); await refreshTrip(); }
      catch (err) { report(err); }
    };
  });
  body.querySelectorAll('[data-paid]').forEach((b) => {
    b.onclick = async () => {
      const x = result.transfers[+b.dataset.paid];
      b.disabled = true;
      const pair = `${nameOf(t, x.from)} → ${nameOf(t, x.to)}`;
      try {
        // 다른 사람이 먼저 눌렀을 수 있다 — 최신 정산에 아직 남아 있는지 확인하고 기록한다
        let cur0 = t;
        try { cur0 = await store.getTrip(t.id); } catch { /* 연결이 없으면 지금 화면 기준 */ }
        const still = settle(cur0).pending.some((p) => p.from === x.from && p.to === x.to && p.amount === x.amount);
        if (!still) {
          view.trip = cur0; renderTrip();
          return toast(`${pair} 송금은 이미 보냈어요로 표시돼 있어요`);
        }
        const exp = {
          kind: 'transfer', title: `송금 ${nameOf(t, x.from)}→${nameOf(t, x.to)}`, date: today(),
          amount: x.amount / 10 ** decimalsOf(cur), currency: cur, rate: null, baseOverride: null,
          payerId: x.from, shares: [{ pid: x.to, w: 1 }],
        };
        let saved = await store.addExpense(t.id, { ...exp, cid: transferKey(cur0, x) });
        view.trip = await store.getTrip(t.id);
        // 같은 표시가 '취소된 기록'을 가리키는데 서버가 되살리지 못한 경우(009 이전 서버) — 새 표시로 한 번 더
        const stillPending = (tr) => settle(tr).pending.some((p) => p.from === x.from && p.to === x.to && p.amount === x.amount);
        if (saved?.duplicate && stillPending(view.trip)) {
          saved = await store.addExpense(t.id, exp);
          view.trip = await store.getTrip(t.id);
        }
        const finished = !settle(view.trip).pending.length;
        if (finished && !saved?.duplicate) {
          store.logEvent(t.id, 'all_paid');
          // 정산이 끝난 순간 = 가장 만족한 순간에 별점 요청 (한 기기 한 번)
          setTimeout(() => askReview('enbbang:review').then((ok) => ok && store.logEvent(t.id, 'review_asked')), 1200);
        }
        renderTrip();
        feedback(finished ? 'done' : 'paid');
        toast(saved?.duplicate ? `${pair} 송금은 방금 다른 사람이 보냈어요로 표시했어요` : `${pair} 송금 완료로 표시했어요`);
      } catch (err) { b.disabled = false; report(err); }
    };
  });
  body.querySelector('#same-new')?.addEventListener('click', () => {
    // 나를 맨 앞에(방 만든 사람 = 나), 나머지는 원래 순서대로
    const myPid = me.get(t.id);
    const names = [...t.participants].sort((a, b) => (a.id === myPid ? -1 : b.id === myPid ? 1 : 0)).map((p) => p.name);
    try { sessionStorage.setItem('enbbang:prefill', JSON.stringify({ names, base: t.baseCurrency })); } catch { /* 무시 */ }
    store.logEvent(t.id, 'new_trip_same');
    location.hash = '#/start';
  });
  body.querySelectorAll('[data-undo]').forEach((b) => {
    b.onclick = () => undoTransfer(t, result.transfers[+b.dataset.undo].paymentId);
  });
  const remind = async (list, msg) => {
    copy(reminderText(t, list, (pid) => nameOf(t, pid), await tripLink(t)), msg);
    store.logEvent(t.id, 'reminder_copied', { count: list.length });
  };
  body.querySelectorAll('[data-remind]').forEach((b) => {
    const x = result.transfers[+b.dataset.remind];
    b.onclick = () => remind([x], `${nameOf(t, x.from)}님에게 보낼 알림을 복사했어요. 카톡에 붙여 넣으세요`);
  });
  body.querySelector('#remind-all')?.addEventListener('click', () => remind(pending, '안 보낸 사람 모두에게 보낼 알림을 복사했어요'));
  // 앱 전용: 내가 보낼 돈이 있으면 내일 오전 10시에 휴대폰 알림
  body.querySelectorAll('[data-alarm]').forEach((b) => {
    const x = result.transfers[+b.dataset.alarm];
    b.onclick = async () => {
      const at = new Date();
      at.setDate(at.getDate() + 1);
      at.setHours(getSettings().alarmHour, 0, 0, 0);
      const r = await scheduleReminder({
        key: `${t.id}:${x.from}:${x.to}`,
        title: `${t.name} 정산`,
        body: `${nameOf(t, x.to)}님께 ${fmt(x.amount, cur)} 보낼 차례예요`,
        at,
        hash: `#/t/${t.id}/settle`,
      });
      if (r === 'scheduled') { haptic('tap'); toast(`내일 ${hourLabel(getSettings().alarmHour)}에 알려 드릴게요`); }
      else if (r === 'denied') toast('알림 권한이 꺼져 있어요. 휴대폰 설정에서 켜 주세요');
    };
  });
  body.querySelectorAll('[data-copy-amt]').forEach((b) => {
    b.onclick = () => copy(String(result.transfers[+b.dataset.copyAmt].amount / 10 ** decimalsOf(cur)), '금액을 복사했어요');
  });
  body.querySelectorAll('[data-copy-acc]').forEach((b) => {
    const [i, j] = b.dataset.copyAcc.split(':').map(Number);
    const x = result.transfers[i];
    b.onclick = () => copy(transferLinks(t.participants.find((p) => p.id === x.to), x.amount, cur)[j].copy, '계좌를 복사했어요');
  });
  body.querySelectorAll('[data-paylink]').forEach((a) => {
    a.addEventListener('click', () => store.logEvent(t.id, 'transfer_link', { kind: a.dataset.paylink }));
  });
  body.querySelector('#stmt-open')?.addEventListener('click', () => statementSheet(t));
  body.querySelector('#share-text').onclick = async () => {
    copy(settlementText(t, result, (pid) => nameOf(t, pid), await tripLink(t)), '정산표를 복사했어요. 카톡에 붙여 넣으세요');
    store.logEvent(t.id, 'settle_shared', { via: 'text' });
  };
  body.querySelector('#share-img').onclick = async () => {
    const blob = await settlementImage(t, result, (pid) => nameOf(t, pid));
    const file = new File([blob], `${t.name}-정산.png`, { type: 'image/png' });
    store.logEvent(t.id, 'settle_shared', { via: 'image' });
    if (await nativeShareImage(blob, `${t.id}-settle.png`, `${t.name} 정산`)) return;
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: `${t.name} 정산` }); return; } catch { /* 취소 → 다운로드로 */ }
    }
    showShareImage(blob, file.name);
  };
  const mark = body.querySelector('#mark');
  if (mark) mark.onclick = async () => {
    try { await store.markSettled(t.id, !t.settledAt); await refreshTrip(); }
    catch (e) { report(e); }
  };
}

// 어디에 썼나 — 카테고리별 합계 막대
function catCard(t, total) {
  const cats = categoryTotals(t);
  if (!cats.length || !total) return '';
  return `<div class="card cat-card" style="margin-top:12px"><b>어디에 썼나요</b>
    ${cats.map((c) => {
      const pct = Math.round((c.total / total) * 100);
      return `<div class="cat-bar"><span class="cat-name">${c.emoji} ${c.label}</span>
        <span class="bar"><i style="width:${Math.max(pct, 2)}%"></i></span>
        <span class="num cat-amt">${fmt(c.total, t.baseCurrency)} <span class="muted">${pct}%</span></span></div>`;
    }).join('')}
  </div>`;
}

function renderPeople(body, t) {
  const myId = me.get(t.id);
  body.innerHTML = `
    <div class="card">
      ${t.participants.map((p) => {
        const i = p.payInfo || {};
        const has = [i.toss && '토스', i.kakao && '카카오페이', i.account && '계좌'].filter(Boolean).join('·');
        const w = p.defaultW ?? 1;
        return `<div class="member ${p.excluded ? 'off' : ''}">
          <div class="row">
            <div class="grow"><div class="t">${esc(p.name)}${p.id === myId ? ' <span class="badge">나</span>' : ''}${p.excluded ? ' <span class="badge">이후 제외</span>' : ''}</div>
              <div class="muted small">${has ? `송금 정보: ${has}` : '송금 정보 없음'}</div></div>
            ${p.id === myId ? `<button class="btn sm" data-payinfo="${esc(p.id)}">내 송금 정보</button>` : ''}
          </div>
          <div class="member-ctl small">
            <span class="muted">기본 몫</span>
            <button type="button" class="step sm" data-wdec="${esc(p.id)}" aria-label="${esc(p.name)} 기본 몫 줄이기">−</button>
            <b class="num">${w}</b>
            <button type="button" class="step sm" data-winc="${esc(p.id)}" aria-label="${esc(p.name)} 기본 몫 늘리기">＋</button>
            <button type="button" class="chip sm grow-end" data-excl="${esc(p.id)}" aria-pressed="${!p.excluded}">${p.excluded ? '새 지출에서 빠짐' : '새 지출에 포함'}</button>
          </div>
        </div>`;
      }).join('')}
      <p class="muted small">기본 몫은 커플처럼 늘 2인분인 사람에게 2를 주세요. 중간에 먼저 떠난 사람은 "새 지출에서 빠짐"으로 바꾸면 지난 기록은 그대로 두고 이후 지출에서만 빠져요.</p>
      <form id="addp" class="row" style="margin-top:12px">
        <input class="input grow" name="n" maxlength="30" placeholder="사람 추가">
        <button class="btn">추가</button></form>
    </div>
    <button class="btn ghost block" id="whoami" style="margin-top:12px">내가 누구인지 다시 고르기</button>
    ${store.mode === 'cloud' && myId ? '<button class="btn ghost block" id="move-dev">📱 다른 기기에서 이어서 쓰기</button>' : ''}
    ${store.mode === 'cloud' && isAdmin(t) ? '<button class="btn ghost block" id="tidy">🧹 참여자 정리 (이름·합치기·빼기)</button>' : ''}`;
  body.querySelector('[data-payinfo]')?.addEventListener('click', () => payInfoSheet(t.participants.find((p) => p.id === myId)));
  const patch = async (pid, data) => {
    try { await store.updateParticipant(t.id, pid, data); await refreshTrip(); } catch (err) { report(err); }
  };
  body.querySelectorAll('[data-wdec]').forEach((b) => {
    const p = t.participants.find((x) => x.id === b.dataset.wdec);
    b.onclick = () => (p.defaultW ?? 1) > 1 && patch(p.id, { defaultW: (p.defaultW ?? 1) - 1 });
  });
  body.querySelectorAll('[data-winc]').forEach((b) => {
    const p = t.participants.find((x) => x.id === b.dataset.winc);
    b.onclick = () => (p.defaultW ?? 1) < 9 && patch(p.id, { defaultW: (p.defaultW ?? 1) + 1 });
  });
  body.querySelectorAll('[data-excl]').forEach((b) => {
    const p = t.participants.find((x) => x.id === b.dataset.excl);
    b.onclick = () => {
      if (!p.excluded && t.participants.filter((x) => !x.excluded).length <= 1) return toast('한 명은 남아 있어야 해요');
      patch(p.id, { excluded: !p.excluded });
    };
  });
  body.querySelector('#addp').onsubmit = async (e) => {
    e.preventDefault();
    const n = new FormData(e.target).get('n').trim();
    if (!n) return;
    if (t.participants.some((p) => p.name === n)) return toast('같은 이름이 이미 있어요');
    try { await store.addParticipant(t.id, n); view.trip = await store.getTrip(t.id); renderTrip(); }
    catch (err) { report(err); }
  };
  body.querySelector('#whoami').onclick = () => pickIdentity();
  body.querySelector('#move-dev')?.addEventListener('click', () => moveSheet(t));
  body.querySelector('#tidy')?.addEventListener('click', () => tidySheet(t));
}

// ───────── 시트 ─────────
let sheetReturn = null; // 시트를 닫으면 포커스를 돌려줄 곳
function openSheet(html, onMount) {
  if (!$sheet.innerHTML) sheetReturn = document.activeElement;
  $sheet.innerHTML = `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" tabindex="-1">${html}</div></div>`;
  const scrim = $sheet.querySelector('.scrim');
  const sheet = $sheet.querySelector('.sheet');
  const h = sheet.querySelector('h2, h3, b');
  if (h) { h.id = h.id || 'sheet-title'; sheet.setAttribute('aria-labelledby', h.id); }
  scrim.addEventListener('click', (e) => { if (e.target === scrim && !scrim.dataset.locked) closeSheet(); });
  onMount(sheet, scrim);
  // onMount가 입력칸에 포커스를 주지 않았으면 시트 자체로 (화면 읽기 프로그램이 시트부터 읽게)
  setTimeout(() => { if (!sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true }); }, 60);
}
function closeSheet() {
  if (!$sheet.innerHTML) return;
  $sheet.innerHTML = '';
  if (sheetReturn?.isConnected) sheetReturn.focus({ preventScroll: true });
  sheetReturn = null;
}
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
document.addEventListener('keydown', (e) => {
  const scrim = $sheet.querySelector('.scrim');
  if (!scrim) return;
  if (e.key === 'Escape' && !scrim.dataset.locked) { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const items = [...scrim.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !scrim.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function pickIdentity() {
  const t = view.trip;
  openSheet(`
    <h2>${esc(t.name)}</h2>
    <p class="muted">이 방에서 누구세요? 고르면 이 기기에 기억해 둘게요.</p>
    <div class="chips">${t.participants.map((p) => `<button class="chip" data-pid="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>
    <form class="row" id="newme" style="margin-top:16px">
      <input class="input grow" name="n" maxlength="30" placeholder="목록에 없으면 이름 입력">
      <button class="btn primary">참여</button></form>`, (el, scrim) => {
    if (!me.get(t.id)) scrim.dataset.locked = '1';
    const done = (pid) => {
      const first = !me.get(t.id);
      me.set(t.id, pid);
      if (first) store.logEvent(t.id, 'joined', { creator: isAdmin(t) });
      store.claimParticipant(t.id, pid).catch(() => {});
      closeSheet();
      renderTrip();
    };
    el.querySelectorAll('[data-pid]').forEach((b) => { b.onclick = () => done(b.dataset.pid); });
    el.querySelector('#newme').onsubmit = async (e) => {
      e.preventDefault();
      const n = new FormData(e.target).get('n').trim();
      if (!n) return;
      const exist = t.participants.find((p) => p.name === n);
      if (exist) return done(exist.id);
      const similar = t.participants.find((p) => p.name.includes(n) || n.includes(p.name));
      if (similar && !confirm(`'${similar.name}'님이 이미 있어요. 같은 분이면 '취소'를 누르고 이름을 골라 주세요.\n'${n}'(으)로 새로 참여할까요?`)) return;
      try { const p = await store.addParticipant(t.id, n); view.trip = await store.getTrip(t.id); done(p.id); }
      catch (err) { report(err); }
    };
  });
}

function payInfoSheet(p) {
  const i = p.payInfo || {};
  openSheet(`
    <h2>내 송금 정보</h2>
    <p class="muted small">받을 돈이 있을 때 친구 화면에 송금 버튼으로 보여요. 필요한 것만 넣으세요.</p>
    <form class="stack" id="pi">
      <label class="field"><span>토스아이디 (toss.me/뒤의 아이디)</span><input class="input" name="toss" value="${esc(i.toss)}" placeholder="예: mytossid"></label>
      <label class="field"><span>카카오페이 송금코드 링크</span><input class="input" name="kakao" value="${esc(i.kakao)}" placeholder="https://qr.kakaopay.com/..."></label>
      <label class="field"><span>계좌 (은행 계좌번호 예금주)</span><input class="input" name="account" value="${esc(i.account)}" placeholder="카카오뱅크 3333-01-1234567 홍길동"></label>
      <p class="muted small">링크를 받은 사람은 모두 이 정보를 볼 수 있어요.</p>
      <div class="row"><button type="button" class="btn grow" id="cancel">취소</button><button class="btn primary grow">저장</button></div>
    </form>`, (el) => {
    el.querySelector('#cancel').onclick = closeSheet;
    el.querySelector('#pi').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const payInfo = Object.fromEntries(['toss', 'kakao', 'account'].map((k) => [k, String(f.get(k)).trim()]).filter(([, v]) => v));
      if (payInfo.kakao && !/^https:\/\/qr\.kakaopay\.com\//.test(payInfo.kakao)) return toast('카카오페이 링크는 https://qr.kakaopay.com/ 으로 시작해요');
      try { await store.updateParticipant(view.trip.id, p.id, { payInfo }); view.trip = await store.getTrip(view.trip.id); closeSheet(); renderTrip(); }
      catch (err) { report(err); }
    };
  });
}

// ───────── 다른 기기에서 이어서 쓰기 ─────────
// 웹(카톡 안 브라우저)에서 쓰다가 앱을 깔면 저장소가 달라 '나'·총무 권한이 사라진다 → 옮기기 링크로 넘긴다
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
async function moveSheet(t) {
  const code = b64u(JSON.stringify({ m: me.get(t.id), d: deviceId(), a: me.adminKey(t.id) || undefined }));
  const url = (await tripLink(t)).replace(/#\/t\/[\w-]+$/, `#/t/${t.id}/mv/${code}`);
  openSheet(`
    <h2>다른 기기에서 이어서 쓰기</h2>
    <p class="muted">앱을 새로 깔았거나 다른 폰·PC에서 이 방을 쓸 때, 아래 링크를 <b>그 기기에서</b> 열면 내 이름·내 지출${isAdmin(t) ? '·총무 권한' : ''}이 그대로 넘어가요.</p>
    <p class="small pay-changed">⚠️ 이 링크를 받은 사람은 나처럼 쓸 수 있어요. 단톡방에 올리지 말고 나에게만 보내 주세요.</p>
    <div class="row"><button type="button" class="btn grow" id="mv-cancel">닫기</button><button type="button" class="btn primary grow" id="mv-copy">링크 복사</button></div>`, (el) => {
    el.querySelector('#mv-cancel').onclick = closeSheet;
    el.querySelector('#mv-copy').onclick = () => { copy(url, '옮기기 링크를 복사했어요. 새 기기에서 열어 주세요'); closeSheet(); };
  });
}
async function importMove(id, code) {
  let data;
  try { data = JSON.parse(unb64u(code)); } catch { data = null; }
  if (!data?.m) { replaceHash(`#/t/${id}`); return toast('옮기기 링크가 올바르지 않아요'); }
  me.set(id, data.m);
  if (data.a) me.setAdminKey(id, data.a);
  try { await store.moveDevice(id, data.d); } catch { /* 이름·총무 키는 옮겨졌다 */ }
  replaceHash(`#/t/${id}`);
  toast('이 기기로 옮겼어요');
}

// ───────── 참여자 정리 (총무) ─────────
function tidySheet(t) {
  const used = (pid) => t.expenses.some((e) => e.payerId === pid || e.shares.some((s) => s.pid === pid));
  openSheet(`
    <h2>참여자 정리</h2>
    <p class="muted small">같은 사람이 두 번 들어왔으면 <b>합치기</b>, 잘못 넣은 사람은 <b>빼기</b>(지출이 없을 때만).</p>
    <div class="stack">${t.participants.map((p) => `
      <div class="tidy-row">
        <b>${esc(p.name)}</b>
        <span class="row">
          <button type="button" class="btn sm ghost" data-rn="${esc(p.id)}">이름</button>
          ${t.participants.length > 1 ? `<button type="button" class="btn sm ghost" data-mg="${esc(p.id)}">합치기</button>` : ''}
          ${!used(p.id) && t.participants.length > 1 ? `<button type="button" class="btn sm ghost" data-rm="${esc(p.id)}">빼기</button>` : ''}
        </span>
      </div>`).join('')}</div>
    <button type="button" class="btn block" id="tidy-close" style="margin-top:14px">닫기</button>`, (el) => {
    const after = async (msg) => { view.trip = await store.getTrip(t.id); closeSheet(); renderTrip(); toast(msg); };
    el.querySelector('#tidy-close').onclick = closeSheet;
    el.querySelectorAll('[data-rn]').forEach((b) => {
      b.onclick = async () => {
        const p = t.participants.find((x) => x.id === b.dataset.rn);
        const n = prompt('새 이름', p.name)?.trim();
        if (!n || n === p.name) return;
        if (t.participants.some((x) => x.name === n)) return toast('같은 이름이 이미 있어요');
        try { await store.updateParticipant(t.id, p.id, { name: n.slice(0, 30) }); await after('이름을 바꿨어요'); } catch (err) { report(err); }
      };
    });
    el.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = async () => {
        const p = t.participants.find((x) => x.id === b.dataset.rm);
        if (!confirm(`${p.name}님을 이 방에서 뺄까요?`)) return;
        try { await store.removeParticipant(t.id, p.id); await after(`${p.name}님을 뺐어요`); } catch (err) { report(err); }
      };
    });
    el.querySelectorAll('[data-mg]').forEach((b) => {
      b.onclick = () => {
        const from = t.participants.find((x) => x.id === b.dataset.mg);
        const box = document.createElement('div');
        box.className = 'tidy-merge';
        box.innerHTML = `<p class="small"><b>${esc(from.name)}</b>님은 누구와 같은 사람인가요? (지출·몫·송금이 옮겨지고 ${esc(from.name)}은 없어져요)</p>
          <div class="chips">${t.participants.filter((x) => x.id !== from.id).map((x) => `<button type="button" class="chip" data-into="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div>`;
        el.querySelector('.tidy-merge')?.remove();
        b.closest('.tidy-row').after(box);
        box.querySelectorAll('[data-into]').forEach((c) => {
          c.onclick = async () => {
            const into = t.participants.find((x) => x.id === c.dataset.into);
            if (!confirm(`${from.name} → ${into.name} 으로 합칠까요? 되돌릴 수 없어요.`)) return;
            try { await store.mergeParticipants(t.id, from.id, into.id); await after(`${from.name}님을 ${into.name}님으로 합쳤어요`); } catch (err) { report(err); }
          };
        });
      };
    });
  });
}

// ───────── 카드 명세서로 맞추기 ─────────
// 외화 지출을 실제 카드 청구액(정산 통화)으로 한 화면에서 맞춘다 — 해외여행 정산의 마지막 단계
const foreignExpenses = (t) => t.expenses.filter((e) => !e.deletedAt && e.kind !== 'transfer' && e.currency !== t.baseCurrency);
function statementCard(t) {
  const fx = foreignExpenses(t);
  if (!fx.length) return '';
  const matched = fx.filter((e) => e.baseOverride != null).length;
  const all = matched === fx.length;
  return `<div class="card stmt-card ${all ? 'done' : ''}">
    <div class="row between"><b>💳 카드 명세서로 맞추기</b><span class="badge">${matched}/${fx.length}건 맞춤</span></div>
    <p class="muted small">${all ? '외화 지출을 모두 실제 청구액으로 맞췄어요.' : `외화로 쓴 지출을 카드 명세서의 실제 청구액(${t.baseCurrency})으로 맞추면 정산이 정확해져요.`}</p>
    <button class="btn block" id="stmt-open">${all ? '다시 보기' : matched ? '이어서 맞추기' : '청구액 넣기'}</button>
  </div>`;
}
function statementSheet(t) {
  const fx = foreignExpenses(t);
  const cur = t.baseCurrency;
  const editable = (e) => e.mine || e.device === deviceId() || isAdmin(t);
  openSheet(`
    <h2>카드 명세서로 맞추기</h2>
    <p class="muted small">명세서에 찍힌 ${cur} 금액을 넣어 주세요. 비워 두면 환율로 계산해요.</p>
    <form id="stmt" class="stack">
      ${fx.map((e) => {
        let est;
        try { est = fmt(expenseBaseMinor({ ...e, baseOverride: null }, cur), cur); } catch { est = '환율 없음'; }
        const ok = editable(e);
        return `<label class="stmt-row ${ok ? '' : 'locked'}">
          <span class="stmt-what"><b>${ok ? '' : '🔒 '}${esc(e.title || '지출')}</b>
            <small>${esc(e.date.slice(5).replace('-', '/'))} · ${fmtMajor(e.amount, e.currency)} · 환율로 ≈ ${est}</small></span>
          <input class="input num" inputmode="decimal" name="${esc(e.id)}" placeholder="청구액" ${ok ? '' : 'disabled'}
            value="${e.baseOverride != null ? Number(e.baseOverride).toLocaleString('ko-KR') : ''}" aria-label="${esc(e.title || '지출')} 청구액"></label>`;
      }).join('')}
      ${fx.some((e) => !editable(e)) ? '<p class="muted small">🔒 표시된 지출은 입력한 사람이나 총무만 바꿀 수 있어요</p>' : ''}
      <div class="row"><button type="button" class="btn grow" id="stmt-cancel">취소</button><button class="btn primary grow">저장</button></div>
    </form>`, (el) => {
    el.querySelector('#stmt-cancel').onclick = closeSheet;
    el.querySelector('#stmt').onsubmit = async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const btn = form.querySelector('.btn.primary');
      if (btn.disabled) return;
      const changes = [];
      for (const e of fx.filter(editable)) {
        const v = form.elements[e.id].value.trim();
        const next = v ? parseAmount(v) : null;
        if (v && !(next > 0)) return toast(`'${e.title || '지출'}' 금액을 숫자로 넣어 주세요`);
        if (next == null && !e.rate) return toast(`'${e.title || '지출'}'은 환율이 없어서 청구액을 비울 수 없어요`);
        if ((next ?? null) !== (e.baseOverride ?? null)) changes.push({ e, next });
      }
      if (!changes.length) { closeSheet(); return toast('바뀐 게 없어요'); }
      btn.disabled = true;
      try {
        for (const c of changes) await store.updateExpense(t.id, c.e.id, { baseOverride: c.next });
        view.trip = await store.getTrip(t.id);
        closeSheet(); renderTrip();
        toast(`${changes.length}건을 실제 청구액으로 맞췄어요`);
      } catch (err) { btn.disabled = false; report(err); }
    };
  });
}

// 송금 정보가 48시간 안에 바뀌었는지 (바꿔치기를 다른 사람이 알아챌 수 있게)
function payChangedRecently(t, pid) {
  const at = t.participants.find((p) => p.id === pid)?.payChangedAt;
  return !!at && Date.now() - Date.parse(at) < 48 * 3600 * 1000;
}

// 받침 있으면 '이', 없으면 '가' (한글이 아니면 '이(가)')
function iGa(name) {
  const c = String(name).charCodeAt(String(name).length - 1);
  if (c >= 0xAC00 && c <= 0xD7A3) return (c - 0xAC00) % 28 ? '이' : '가';
  return '이(가)';
}

// 저장된 shares에서 나누기 방식을 되살린다: a(금액)가 있으면 금액 지정, 몫이 1이 아니면 몫, 아니면 똑같이
function splitModeOf(shares) {
  if (shares.some((s) => s.a != null)) return 'exact';
  if (shares.some((s) => s.w !== 1)) return 'parts';
  return 'equal';
}

function expenseSheet(exp) {
  const t = view.trip;
  const myId = me.get(t.id);
  const editing = !!exp;
  const canEdit = !editing || exp.mine || exp.device === deviceId() || isAdmin(t); // mine: 서버, device: 로컬 모드·저장 대기
  const e = exp || {
    title: '', date: today(), amount: '', currency: lastCurrency(t), rate: '', baseOverride: '',
    payerId: myId || t.participants[0].id,
    // 새 지출 기본값: "이후 제외"된 사람은 빼고, 각자의 기본 몫(커플 2 등)을 쓴다
    shares: t.participants.filter((p) => !p.excluded).map((p) => ({ pid: p.id, w: p.defaultW ?? 1 })),
  };
  const people = t.participants;
  const st = {
    payerId: e.payerId,
    mode: splitModeOf(e.shares),
    sel: new Set(e.shares.filter((s) => s.w > 0).map((s) => s.pid)),
    parts: new Map(people.map((p) => [p.id, e.shares.find((s) => s.pid === p.id)?.w ?? 0])),
    exact: new Map(people.map((p) => [p.id, String(e.shares.find((s) => s.pid === p.id)?.a ?? '')])),
    open: null,
    cat: e.category || guessCategory(e.title),
    catTouched: !!e.category, // 사용자가 직접 고르면 제목으로 추측하지 않는다
    receipt: e.receipt || null, // 저장된 사진 경로
    photo: null, // 새로 고른 사진(아직 안 올림)
  };
  if (st.mode !== 'parts') people.forEach((p) => st.parts.set(p.id, st.sel.has(p.id) ? 1 : 0));

  openSheet(`
    <h2>${editing ? '지출 수정' : '지출 추가'}</h2>
    <form class="stack" id="ef">
      <div class="amount-row">
        <input class="input amount num" name="amount" inputmode="decimal" autocomplete="off" value="${esc(e.amount)}" placeholder="0" aria-label="금액" required>
        <select class="input cur" name="currency" aria-label="통화">${CURRENCIES.map((c) => `<option ${c === e.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <input class="input" name="title" maxlength="100" value="${esc(e.title)}" placeholder="어디에 썼나요? 예: 저녁 이자카야" aria-label="내용" required>
      <div class="cats" role="radiogroup" aria-label="카테고리">${CATEGORIES.map((c) =>
        `<button type="button" class="cat" role="radio" data-cat="${c.id}"><span>${c.emoji}</span>${c.label}</button>`).join('')}</div>
      <div class="receipt-row">
        <div id="rc-thumb" class="rc-thumb hidden"></div>
        <button type="button" class="btn sm ghost" id="rc-camera">📷 영수증 찍기</button>
        <button type="button" class="btn sm ghost" id="rc-gallery">🖼 앨범</button>
      </div>
      <div id="fx" class="fx ${e.currency === t.baseCurrency ? 'hidden' : ''}">
        <label class="fx-row"><span id="rate-label">환율</span>
          <input class="input num fx-rate" name="rate" inputmode="decimal" value="${esc(e.rate ? tidy(e.rate * rateUnit(e.currency)) : '')}"><span class="muted">${t.baseCurrency}</span></label>
        <details ${e.baseOverride != null && e.baseOverride !== '' ? 'open' : ''}><summary class="small">실제 카드 청구액으로 맞추기</summary>
          <label class="fx-row"><span>청구액</span><input class="input num" name="baseOverride" inputmode="decimal" value="${esc(e.baseOverride ?? '')}" placeholder="넣으면 환율보다 우선"><span class="muted">${t.baseCurrency}</span></label>
        </details>
        <p class="muted small" id="fx-note"></p>
      </div>
      <p class="summary-line" id="summary"></p>
      <div id="payer-pick" class="card panel hidden">
        <span class="muted small">누가 냈나요?</span>
        <div class="chips">${people.map((p) => `<button type="button" class="chip" data-payer="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>
      </div>
      <div id="split" class="card panel hidden">
        <div class="seg small-seg" role="radiogroup" aria-label="나누는 방식">
          <button type="button" role="radio" data-split="equal">똑같이</button>
          <button type="button" role="radio" data-split="parts">몫대로</button>
          <button type="button" role="radio" data-split="exact">금액 직접</button>
        </div>
        <div id="split-body"></div>
      </div>
      <label class="field date-row"><span>날짜</span><input class="input" type="date" name="date" value="${esc(e.date)}"></label>
      ${canEdit ? '' : '<p class="minus small">이 지출은 입력한 사람이나 총무만 고칠 수 있어요.</p>'}
      <div class="row">
        ${editing && canEdit ? '<button type="button" class="btn ghost" id="del">삭제</button>' : ''}
        <button type="button" class="btn grow" id="cancel">닫기</button>
        ${canEdit ? `<button class="btn primary grow">${editing ? '저장' : '추가'}</button>` : ''}
      </div>
    </form>`, (el) => {
    const f = el.querySelector('#ef');
    const fx = el.querySelector('#fx');
    const cur = () => f.currency.value;
    const totalMinor = () => { const a = parseAmount(f.amount.value); return a > 0 ? toMinor(a, cur()) : 0; };

    // 현재 선택으로 사람별 몫(통화 최소 단위)을 계산 — 미리보기와 검증에 같이 쓴다
    const allocation = () => {
      const total = totalMinor();
      if (st.mode === 'exact') {
        return people.map((p) => {
          const v = parseAmount(st.exact.get(p.id) || 0);
          return { pid: p.id, minor: v > 0 ? toMinor(v, cur()) : 0 };
        });
      }
      const ws = people.map((p) => (st.mode === 'parts' ? st.parts.get(p.id) : st.sel.has(p.id) ? 1 : 0));
      if (!total || !ws.some((w) => w > 0)) return people.map((p) => ({ pid: p.id, minor: 0 }));
      const parts = splitMinor(total, ws.map((w) => w || 0));
      return people.map((p, i) => ({ pid: p.id, minor: ws[i] > 0 ? parts[i] : 0 }));
    };

    const renderSummary = () => {
      const payer = nameOf(t, st.payerId);
      let who;
      if (st.mode === 'exact') who = '금액을 정해서';
      else if (st.mode === 'parts') who = '몫대로';
      else who = st.sel.size === people.length ? '전원 똑같이' : `${st.sel.size}명 똑같이`;
      let tail = '';
      const total = totalMinor();
      if (st.mode === 'equal' && st.sel.size && total) tail = ` · 1인당 약 ${fmt(Math.round(total / st.sel.size), cur())}`;
      if (st.mode === 'exact' && total) {
        const left = total - allocation().reduce((a, x) => a + x.minor, 0);
        tail = left ? ` · <span class="minus">${left > 0 ? '남은' : '초과'} ${fmt(Math.abs(left), cur())}</span>` : ' · 딱 맞아요 ✓';
      }
      el.querySelector('#summary').innerHTML = `
        <button type="button" class="link-btn" data-open="payer-pick">${esc(payer)}</button>${iGa(payer)} 내고
        <button type="button" class="link-btn" data-open="split">${who}</button> 나눠요${tail}`;
      el.querySelectorAll('[data-open]').forEach((b) => {
        b.onclick = () => togglePanel(b.dataset.open);
      });
    };

    const togglePanel = (id) => {
      st.open = st.open === id ? null : id;
      ['payer-pick', 'split'].forEach((p) => el.querySelector(`#${p}`).classList.toggle('hidden', st.open !== p));
    };

    const renderSplit = () => {
      el.querySelectorAll('[data-split]').forEach((b) => b.setAttribute('aria-checked', b.dataset.split === st.mode));
      const body = el.querySelector('#split-body');
      const alloc = new Map(allocation().map((x) => [x.pid, x.minor]));
      const amt = (pid) => (totalMinor() && alloc.get(pid) ? fmt(alloc.get(pid), cur()) : '');
      if (st.mode === 'equal') {
        body.innerHTML = `
          <div class="chips">${people.map((p) => `<button type="button" class="chip" data-sel="${esc(p.id)}" aria-pressed="${st.sel.has(p.id)}">${esc(p.name)}</button>`).join('')}</div>
          <div class="row between small muted"><span>${st.sel.size ? '빠질 사람은 눌러서 끄세요' : '한 명 이상 골라 주세요'}</span>
            <button type="button" class="btn sm ghost" id="sel-all">전원</button></div>`;
        body.querySelectorAll('[data-sel]').forEach((b) => {
          b.onclick = () => {
            st.sel.has(b.dataset.sel) ? st.sel.delete(b.dataset.sel) : st.sel.add(b.dataset.sel);
            refresh();
          };
        });
        body.querySelector('#sel-all').onclick = () => { people.forEach((p) => st.sel.add(p.id)); refresh(); };
      } else if (st.mode === 'parts') {
        body.innerHTML = `<p class="muted small">커플은 2, 술 안 마신 사람은 0처럼 몫을 정하세요.</p>
          ${people.map((p) => `<div class="part-row">
            <span class="grow">${esc(p.name)}</span>
            <button type="button" class="step" data-dec="${esc(p.id)}" aria-label="${esc(p.name)} 몫 줄이기">−</button>
            <b class="num part-n">${st.parts.get(p.id)}</b>
            <button type="button" class="step" data-inc="${esc(p.id)}" aria-label="${esc(p.name)} 몫 늘리기">＋</button>
            <span class="num muted part-amt">${amt(p.id)}</span></div>`).join('')}`;
        body.querySelectorAll('[data-dec]').forEach((b) => {
          b.onclick = () => { st.parts.set(b.dataset.dec, Math.max(0, st.parts.get(b.dataset.dec) - 1)); refresh(); };
        });
        body.querySelectorAll('[data-inc]').forEach((b) => {
          b.onclick = () => { st.parts.set(b.dataset.inc, Math.min(9, st.parts.get(b.dataset.inc) + 1)); refresh(); };
        });
      } else {
        body.innerHTML = `<p class="muted small">각자 쓴 금액(${cur()})을 적으세요. 합계가 총액과 같아야 해요.</p>
          ${people.map((p) => `<label class="part-row"><span class="grow">${esc(p.name)}</span>
            <input class="input num exact-in" inputmode="decimal" data-exact="${esc(p.id)}" value="${esc(st.exact.get(p.id))}" placeholder="0"></label>`).join('')}`;
        body.querySelectorAll('[data-exact]').forEach((i) => {
          i.oninput = () => { st.exact.set(i.dataset.exact, i.value); renderSummary(); };
        });
      }
    };

    const refresh = () => { renderSummary(); renderSplit(); };

    const renderCats = () => {
      el.querySelectorAll('[data-cat]').forEach((b) => b.setAttribute('aria-checked', b.dataset.cat === st.cat));
    };
    el.querySelectorAll('[data-cat]').forEach((b) => {
      b.onclick = () => {
        st.cat = st.cat === b.dataset.cat ? null : b.dataset.cat; // 다시 누르면 해제
        st.catTouched = true;
        renderCats();
      };
    });
    f.title.oninput = () => {
      if (!st.catTouched) { st.cat = guessCategory(f.title.value); renderCats(); }
    };
    renderCats();

    // ── 영수증 사진: 미리보기 썸네일, ×로 빼기, 누르면 크게 보기 ──
    const thumb = el.querySelector('#rc-thumb');
    let thumbUrl = null;
    const renderThumb = async () => {
      if (thumbUrl?.startsWith('blob:')) URL.revokeObjectURL(thumbUrl);
      thumbUrl = st.photo ? URL.createObjectURL(st.photo) : st.receipt ? await store.receiptUrl(st.receipt).catch(() => null) : null;
      thumb.classList.toggle('hidden', !thumbUrl);
      thumb.innerHTML = thumbUrl ? `<img src="${esc(thumbUrl)}" alt="영수증"><button type="button" class="rc-x" aria-label="사진 빼기">×</button>` : '';
      if (!thumbUrl) return;
      thumb.querySelector('img').onclick = () => showPhoto(thumbUrl);
      thumb.querySelector('.rc-x').onclick = () => { st.photo = null; st.receipt = null; renderThumb(); };
    };
    const choose = async (source) => {
      const raw = await pickPhoto(source);
      if (!raw) return;
      try { st.photo = await compressImage(raw); } catch { return toast('사진을 읽지 못했어요'); }
      haptic('tap');
      renderThumb();
    };
    el.querySelector('#rc-camera').onclick = () => choose('camera');
    el.querySelector('#rc-gallery').onclick = () => choose('gallery');
    renderThumb();

    el.querySelectorAll('[data-split]').forEach((b) => {
      b.onclick = () => {
        const next = b.dataset.split;
        if (next === st.mode) return;
        // 방식을 바꿀 때 지금 고른 사람을 이어받는다
        const active = st.mode === 'parts' ? new Set(people.filter((p) => st.parts.get(p.id) > 0).map((p) => p.id)) : st.sel;
        if (next === 'parts') people.forEach((p) => st.parts.set(p.id, active.has(p.id) ? Math.max(1, st.parts.get(p.id)) : 0));
        if (next === 'equal') st.sel = new Set(active);
        st.mode = next;
        refresh();
      };
    });
    el.querySelectorAll('[data-payer]').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.payer === st.payerId);
      b.onclick = () => {
        st.payerId = b.dataset.payer;
        el.querySelectorAll('[data-payer]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.payer === st.payerId));
        togglePanel('payer-pick');
        renderSummary();
      };
    });

    const updateFx = async () => {
      fx.classList.toggle('hidden', cur() === t.baseCurrency);
      el.querySelector('#rate-label').textContent = `${rateUnit(cur()).toLocaleString('ko-KR')} ${cur()} =`;
      if (cur() === t.baseCurrency) return;
      const note = el.querySelector('#fx-note');
      if (!f.rate.value || f.dataset.autoRateFor !== cur()) {
        note.textContent = '환율 불러오는 중…';
        const r = await getRate(cur(), t.baseCurrency);
        if (r) {
          if (!editing || f.dataset.autoRateFor) f.rate.value = tidy(r.rate * rateUnit(cur()));
          f.dataset.autoRateFor = cur();
          f.dataset.refRate = r.rate; // 단위 실수 경고용 (1단위 기준)
          note.innerHTML = `${esc(r.date)} 참고 환율이에요. 카드 청구액과 다를 수 있어요 · <a href="${RATE_ATTRIBUTION.href}" target="_blank" rel="noopener">${RATE_ATTRIBUTION.text}</a>`;
        } else note.textContent = '환율을 못 불러왔어요. 직접 입력해 주세요.';
      }
    };
    if (editing) f.dataset.autoRateFor = e.currency;
    f.currency.onchange = () => { f.dataset.autoRateFor = ''; f.rate.value = ''; updateFx(); refresh(); };
    // 천 단위 쉼표 — 끝에서 타이핑할 때만 다시 써서 커서가 튀지 않게
    const withCommas = (v) => {
      const [i, d] = String(v).replace(/[^\d.]/g, '').split('.');
      return (i || '').replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d !== undefined ? '.' + d.slice(0, 2) : '');
    };
    if (f.amount.value) f.amount.value = withCommas(f.amount.value);
    f.amount.oninput = () => {
      if (f.amount.selectionStart === f.amount.value.length) f.amount.value = withCommas(f.amount.value);
      refresh();
    };
    el.querySelector('#cancel').onclick = closeSheet;
    const del = el.querySelector('#del');
    if (del) del.onclick = async () => {
      try {
        await store.deleteExpense(t.id, exp.id);
        view.trip = await store.getTrip(t.id);
        closeSheet(); renderTrip();
        toast(`'${exp.title}' 지출을 지웠어요`, { label: '되돌리기', run: () => restoreExpense(t.id, exp.id, '지출을 되살렸어요') });
      } catch (err) { report(err); }
    };
    updateFx(); refresh();
    if (!editing) setTimeout(() => f.amount.focus(), 50); // 금액부터 바로 입력

    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const amount = parseAmount(f.amount.value);
      if (!(amount > 0)) { f.amount.focus(); return toast('금액을 확인해 주세요'); }
      let shares;
      // 참여자 목록 순서 유지 — 1원 배분 순서가 기기마다 같아야 한다
      if (st.mode === 'equal') {
        if (!st.sel.size) { togglePanel('split'); return toast('누구 몫인지 한 명 이상 골라 주세요'); }
        shares = people.filter((p) => st.sel.has(p.id)).map((p) => ({ pid: p.id, w: 1 }));
      } else if (st.mode === 'parts') {
        shares = people.filter((p) => st.parts.get(p.id) > 0).map((p) => ({ pid: p.id, w: st.parts.get(p.id) }));
        if (!shares.length) { if (st.open !== 'split') togglePanel('split'); return toast('몫을 한 명 이상 정해 주세요'); }
      } else {
        const alloc = allocation();
        const sum = alloc.reduce((a, x) => a + x.minor, 0);
        if (sum !== totalMinor()) { if (st.open !== 'split') togglePanel('split'); return toast('사람별 금액의 합계가 총액과 달라요'); }
        shares = alloc.filter((x) => x.minor > 0).map((x) => ({ pid: x.pid, w: x.minor, a: fromMinor(x.minor, cur()) }));
      }
      const c = cur();
      const data = {
        title: f.title.value.trim(), date: f.date.value || today(), amount, currency: c,
        // 고칠 때 환율 칸을 안 건드렸으면 원래 값 그대로 (화면은 반올림해 보여 주므로)
        rate: c === t.baseCurrency ? null
          : editing && c === e.currency && e.rate && f.rate.value === String(tidy(e.rate * rateUnit(c))) ? e.rate
          : (parseAmount(f.rate.value) / rateUnit(c)) || null,
        baseOverride: c === t.baseCurrency || !f.baseOverride.value.trim() ? null : parseAmount(f.baseOverride.value),
        payerId: st.payerId, shares, category: st.cat,
      };
      if (c !== t.baseCurrency && !data.rate && data.baseOverride == null) return toast('환율이나 카드 청구액을 넣어 주세요');
      // 단위 실수(1엔·100엔 기준 숫자를 넣음) 막기: 참고 환율과 3배 넘게 다르면 한 번 묻는다
      const ref = Number(f.dataset.refRate);
      if (data.rate && ref && (data.rate / ref > 3 || ref / data.rate > 3)) {
        const u = rateUnit(c).toLocaleString('ko-KR');
        if (!confirm(`환율이 참고 환율(${u} ${c} = ${fmtMajor(ref * rateUnit(c), t.baseCurrency)})과 크게 달라요.\n${u} ${c} 기준 금액이 맞나요? 그대로 저장할까요?`)) return;
      }
      const submitBtn = f.querySelector('.btn.primary');
      if (submitBtn.disabled) return; // 두 번 눌러 같은 지출이 두 번 들어가지 않게
      submitBtn.disabled = true;
      let photoSkipped = false;
      try {
        if (st.photo) {
          submitBtn.textContent = '사진 올리는 중…';
          try { data.receipt = await store.uploadReceipt(t.id, st.photo); }
          catch (err) {
            if (!isNetErr(err)) throw err;
            data.receipt = st.receipt; // 사진은 연결이 필요해서 이번엔 빼고 지출만 저장
            photoSkipped = true;
          }
        } else {
          data.receipt = st.receipt; // 그대로 두거나, ×로 뺐으면 null
        }
        const saved = editing ? await store.updateExpense(t.id, exp.id, data) : await store.addExpense(t.id, data);
        try { localStorage.setItem(`enbbang:lastcur:${t.id}`, c); } catch { /* 무시 */ }
        view.trip = await store.getTrip(t.id);
        closeSheet(); renderTrip();
        feedback('add');
        const done = editing ? '저장했어요' : '추가했어요';
        if (photoSkipped) toast(`${done} · 사진은 인터넷이 연결되면 다시 붙여 주세요`);
        else if (saved?.pending || pendingCount(t.id)) toast(`${done} · 연결되면 자동으로 저장돼요`);
        else toast(done);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = editing ? '저장' : '추가';
        report(err);
      }
    };
  });
}

// ───────── 탭 스와이프 (지출 ↔ 정산 ↔ 멤버) ─────────
// 손가락을 왼쪽으로 밀면 오른쪽 탭, 오른쪽으로 밀면 왼쪽 탭 (갤럭시·카톡 탭과 같은 방향)
const TAB_ORDER = ['list', 'settle', 'people'];
const swipe = { x: 0, y: 0, t: 0, active: false, decided: false, horizontal: false };
const SWIPE_IGNORE = 'input, textarea, select, .cats, .scrim, .seg, .chips, [data-noswipe]';

function swipeTarget(dir) {
  const i = TAB_ORDER.indexOf(view.tab) + dir;
  return i >= 0 && i < TAB_ORDER.length ? TAB_ORDER[i] : null;
}

addEventListener('touchstart', (e) => {
  const tch = e.touches[0];
  swipe.active = false;
  if (!view.tripId || e.touches.length > 1 || $sheet.innerHTML) return;
  // 화면 가장자리는 안드로이드 "뒤로가기" 제스처 영역이라 양보
  if (tch.clientX < 24 || tch.clientX > innerWidth - 24) return;
  if (e.target.closest(SWIPE_IGNORE)) return;
  Object.assign(swipe, { x: tch.clientX, y: tch.clientY, t: Date.now(), active: true, decided: false, horizontal: false });
}, { passive: true });

addEventListener('touchmove', (e) => {
  if (!swipe.active) return;
  const dx = e.touches[0].clientX - swipe.x;
  const dy = e.touches[0].clientY - swipe.y;
  if (!swipe.decided && Math.hypot(dx, dy) > 12) {
    swipe.decided = true;
    swipe.horizontal = Math.abs(dx) > Math.abs(dy) * 1.4;
  }
  if (!swipe.horizontal) return;
  const body = document.getElementById('tab-body');
  if (!body) return;
  const edge = !swipeTarget(dx < 0 ? 1 : -1); // 끝 탭이면 살짝만 따라오게
  body.style.transition = 'none';
  body.style.transform = `translateX(${dx * (edge ? 0.15 : 0.45)}px)`;
  body.style.opacity = String(1 - Math.min(Math.abs(dx) / 900, 0.25));
}, { passive: true });

addEventListener('touchend', (e) => {
  if (!swipe.active) return;
  swipe.active = false;
  const body = document.getElementById('tab-body');
  const reset = () => {
    if (!body) return;
    body.style.transition = 'transform .2s ease, opacity .2s ease';
    body.style.transform = '';
    body.style.opacity = '';
  };
  if (!swipe.horizontal) return reset();
  const dx = e.changedTouches[0].clientX - swipe.x;
  const fast = Date.now() - swipe.t < 300 && Math.abs(dx) > 60;
  const next = Math.abs(dx) > innerWidth * 0.22 || fast ? swipeTarget(dx < 0 ? 1 : -1) : null;
  if (!next) return reset();
  haptic('tap');
  view.slide = dx < 0 ? 'left' : 'right';
  goTab(next);
}, { passive: true });

// 정산 이미지 보기 — 공유창이 없는 브라우저(카톡 안 브라우저 등)는 내려받기도 막혀 있어서 눌러도 반응이 없었다 (10/7)
// 이미지를 화면에 띄우고 "길게 눌러 저장"을 안내한다. 내려받기가 되는 PC 브라우저는 저장 버튼도 같이
async function showShareImage(blob, name) {
  const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(blob); });
  const inApp = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent);
  openSheet(`<h3>정산 이미지</h3>
    <img class="share-img" src="${url}" alt="정산 결과 이미지">
    <p class="muted small">${inApp ? '이미지를 <b>길게 눌러</b> 저장한 뒤 단톡방에 보내 주세요.' : '이미지를 길게 누르거나 아래 버튼으로 저장해 단톡방에 보내 주세요.'}</p>
    <div class="row">${inApp ? '' : `<a class="btn primary grow" href="${url}" download="${esc(name)}">이미지 저장</a>`}
      <button class="btn grow" id="img-close">닫기</button></div>`, (el) => {
    el.querySelector('#img-close').onclick = closeSheet;
  });
}

// 영수증 크게 보기 (화면 아무 데나 누르면 닫힘)
function showPhoto(url) {
  const v = document.createElement('div');
  v.className = 'photo-viewer';
  v.setAttribute('role', 'dialog');
  v.innerHTML = `<img src="${esc(url)}" alt="영수증 사진"><span class="muted small">눌러서 닫기</span>`;
  v.onclick = () => v.remove();
  document.body.append(v);
}

// ───────── 설정 (오른쪽 위 ⚙) ─────────
const GEAR = `<button type="button" class="icon-btn gear" data-settings aria-label="설정">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg></button>`;

const hourLabel = (h) => (h < 12 ? `오전 ${h}시` : h === 12 ? '오후 12시' : `오후 ${h - 12}시`);

function settingsSheet() {
  const s = getSettings();
  const seg = (key, opts) => `<div class="seg small-seg" role="radiogroup">${opts.map(([v, l]) =>
    `<button type="button" role="radio" data-set="${key}" data-val="${v}" aria-checked="${String(s[key]) === v}">${l}</button>`).join('')}</div>`;
  const hours = Array.from({ length: 15 }, (_, i) => i + 7)
    .map((h) => `<option value="${h}" ${h === s.alarmHour ? 'selected' : ''}>${hourLabel(h)}</option>`).join('');
  openSheet(`
    <h2>설정</h2>
    <div class="stack">
      <div class="field"><span>진동</span>${seg('vibration', [['off', '끔'], ['short', '짧게'], ['long', '길게']])}</div>
      <div class="field"><span>효과음</span>${seg('sound', [['false', '끔'], ['true', '켬']])}</div>
      <div class="field"><span>화면</span>${seg('theme', [['system', '휴대폰 설정'], ['light', '밝게'], ['dark', '어둡게']])}</div>
      ${isApp ? `<label class="field"><span>"내일 알림" 시각</span><select class="input" id="alarm-hour">${hours}</select></label>` : ''}
      <div class="card about small">
        <div class="row between"><span class="muted">버전</span><b>${esc(window.APP_VERSION || '웹')}</b></div>
        <div class="row between"><a href="support.html">도움말</a><a href="privacy.html">개인정보처리방침</a><a href="mailto:sosolab100@gmail.com?subject=${encodeURIComponent('트립N빵 문의')}">문의하기</a></div>
      </div>
      <button type="button" class="btn block" id="set-close">닫기</button>
    </div>`, (el) => {
    el.querySelectorAll('[data-set]').forEach((b) => {
      b.onclick = () => {
        const key = b.dataset.set;
        const val = key === 'sound' ? b.dataset.val === 'true' : b.dataset.val;
        setSetting(key, val);
        el.querySelectorAll(`[data-set="${key}"]`).forEach((x) => x.setAttribute('aria-checked', x === b));
        if (key === 'vibration') haptic('add'); // 바꾼 세기를 바로 느껴 보게
        if (key === 'sound' && val) feedback('add');
      };
    });
    el.querySelector('#alarm-hour')?.addEventListener('change', (e) => setSetting('alarmHour', Number(e.target.value)));
    el.querySelector('#set-close').onclick = closeSheet;
  });
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-settings]')) settingsSheet(); });

function lastCurrency(t) {
  let saved = null;
  try { saved = localStorage.getItem(`enbbang:lastcur:${t.id}`); } catch { /* 사생활 보호 모드 */ }
  if (saved) return saved;
  // 아직 이 기기에서 지출을 안 넣었으면: 이 방에서 가장 최근 외화 지출 통화 → 방 이름으로 짐작한 여행지 통화 → 정산 통화
  const recent = [...t.expenses].reverse().find((e) => !e.deletedAt && e.kind !== 'transfer' && e.currency !== t.baseCurrency);
  const guess = recent?.currency || guessCurrency(t.name);
  return guess && CURRENCIES.includes(guess) ? guess : t.baseCurrency;
}

// ───────── 초대(공유) ─────────
async function tripLink(t) {
  const page = location.href.split('#')[0];
  // 앱 안 주소(localhost)가 아니라 실제 도메인으로 공유
  const base = isApp ? SITE : page.replace(/\?local=1$/, '');
  return store.mode === 'cloud' ? `${base}#/t/${t.id}` : `${page}#/s/${await encodeSnapshot(t)}`;
}

async function shareTrip(t) {
  const url = await tripLink(t);
  const inviter = t.participants.find((p) => p.id === me.get(t.id))?.name;
  const text = inviter
    ? `✈️ ${inviter}님이 '${t.name}' 정산방에 초대했어요. 이름만 고르고 쓴 돈 같이 적어요 (트립N빵)`
    : `✈️ ${t.name} 정산방이에요. 이름만 고르고 쓴 돈 같이 적어요 (트립N빵)`;
  store.logEvent(t.id, 'invite_shared', { via: navigator.share ? 'share' : 'copy' });
  sessionStorage.removeItem(`fresh:${t.id}`);
  if (await nativeShare({ title: t.name, text, url })) return;
  if (navigator.share) {
    try { await navigator.share({ title: t.name, text, url }); return; } catch { /* 취소 → 복사 */ }
  }
  copy(`${text}\n${url}`, store.mode === 'cloud' ? '초대 링크를 복사했어요. 단톡방에 붙여 넣으세요' : '현재 상태 링크를 복사했어요');
}

// ───────── 안드로이드 뒤로가기 ─────────
// 앱 안에서 이동한 만큼만 뒤로 간다(history.state.d = 깊이). 링크·알림으로 바로 열린 화면은 돌아갈 기록이 없어서
// 예전처럼 history.back()을 부르면 아무 반응이 없었다 → 첫 화면으로 보고 "한 번 더 누르면 종료"
let depth = 0;
let replacing = false;
let backAt = 0;
function replaceHash(h) { replacing = true; location.replace(h); }
// 탭 전환은 기록을 쌓지 않는다 — 탭을 여러 번 바꾼 뒤 뒤로가기를 눌러도 탭을 거슬러 가지 않고 방 밖으로 (10/7)
function goTab(tab) {
  if (!view.tripId) return;
  const h = `#/t/${view.tripId}${tab === 'list' ? '' : '/' + tab}`;
  if (location.hash !== h) replaceHash(h);
}
function onHashChange() {
  const d = history.state?.d;
  if (replacing) { replacing = false; history.replaceState({ d: depth }, ''); }
  else if (typeof d === 'number') depth = d;
  else { depth += 1; history.replaceState({ d: depth }, ''); }
  route();
}
// true = 앱이 처리함, false = 앱 종료
function onBack() {
  const viewer = document.querySelector('.photo-viewer');
  if (viewer) { viewer.remove(); return true; }
  if ($sheet.innerHTML) { closeSheet(); return true; }
  if (depth > 0) { history.back(); return true; }
  if (Date.now() - backAt < 2000) return false;
  backAt = Date.now();
  toast('한 번 더 누르면 종료돼요');
  return true;
}

// ───────── 유입 경로 ─────────
// 블로그·쇼츠·인스타 링크에 붙인 utm을 첫 방문 때 기억해 두었다가(30일), 방을 만들 때 지표로 남긴다 (10/7)
const UTM_KEY = 'enbbang:utm';
function rememberUtm() {
  const q = new URLSearchParams(location.search);
  const source = q.get('utm_source');
  if (!source) return;
  try {
    const old = JSON.parse(localStorage.getItem(UTM_KEY) || 'null');
    if (old && Date.now() - old.at < 30 * 864e5) return; // 첫 유입을 우선
    localStorage.setItem(UTM_KEY, JSON.stringify({
      source: source.slice(0, 40), medium: (q.get('utm_medium') || '').slice(0, 40), campaign: (q.get('utm_campaign') || '').slice(0, 40), at: Date.now(),
    }));
  } catch { /* 저장 불가 */ }
}
function firstTouch() {
  try {
    const u = JSON.parse(localStorage.getItem(UTM_KEY) || 'null');
    if (u && Date.now() - u.at < 30 * 864e5) return { source: u.source, medium: u.medium, campaign: u.campaign, app: isApp };
  } catch { /* 무시 */ }
  return { source: '', app: isApp };
}

// ───────── 시작 ─────────
(async () => {
  // ?local=1 — 테스트·시연용. 실서버 지표를 오염시키지 않도록 로컬 모드로 강제
  const forceLocal = new URLSearchParams(location.search).has('local');
  applyTheme(); // 저장된 화면 테마 먼저
  rememberUtm();
  store = await createStore(forceLocal ? null : window.ENBBANG_CONFIG);
  window.__enbbang = { store }; // 디버깅용
  history.replaceState({ d: 0 }, '');
  addEventListener('hashchange', onHashChange);
  initNative({
    onOpenHash: (h) => { if (location.hash !== h) location.hash = h; else route(); },
    // 안드로이드 뒤로가기: 사진·시트 닫기 → 앱 안에서 온 이전 화면 → (첫 화면이면) 두 번 눌러 종료
    onBack,
  });
  route();
})();
