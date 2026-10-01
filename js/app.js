// 엔빵 웹 베타 — 화면 로직 (프레임워크 없음, 해시 라우팅)
import { settle, expenseBaseMinor, decimalsOf } from './settle.js';
import { createStore, me, recentTrips, deviceId } from './store.js';
import { getRate, RATE_ATTRIBUTION } from './rates.js';
import {
  encodeSnapshot, decodeSnapshot, fmt, fmtMajor, settlementText, settlementImage, transferLinks,
} from './share.js';

const CURRENCIES = ['KRW', 'JPY', 'USD', 'EUR', 'TWD', 'VND', 'THB', 'PHP', 'CNY', 'HKD', 'SGD', 'GBP', 'AUD'];
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');

let store;
let view = { tripId: null, trip: null, tab: 'list', q: '', unsub: null };

// ───────── 유틸 ─────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('sv-SE');
const parseAmount = (s) => Number(String(s).replace(/[,\s]/g, ''));

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('on'), 2200);
}

async function copy(text, msg = '복사했어요') {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(msg);
  }
}

function nameOf(trip, pid) { return trip.participants.find((p) => p.id === pid)?.name ?? '?'; }
const isAdmin = (trip) => !!me.adminKey(trip.id);

// ───────── 라우터 ─────────
async function route() {
  if (view.unsub) { view.unsub(); view.unsub = null; }
  closeSheet();
  const h = location.hash.slice(1);
  let m;
  if ((m = h.match(/^\/t\/([\w-]+)(?:\/(\w+))?/))) return openTrip(m[1], m[2] || 'list');
  if ((m = h.match(/^\/s\/(.+)$/))) return importSnapshot(m[1]);
  renderHome();
}

// ───────── 홈 ─────────
function renderHome() {
  view = { ...view, tripId: null, trip: null };
  const recent = recentTrips();
  $app.innerHTML = `
    <div class="hero">
      <div class="row between"><span class="badge">${store.mode === 'cloud' ? '실시간 공유' : '로컬 모드'}</span></div>
      <h1>여행 정산,<br>링크 하나로 끝.</h1>
      <p>가입·설치 없이 같이 입력하고, 누가 누구에게 얼마 보낼지 <b>최소 이체</b>로 정리해 드려요.</p>
    </div>
    <form class="card stack" id="create">
      <label class="field"><span>여행 이름</span>
        <input class="input" name="name" maxlength="60" placeholder="예: 10월 오사카 3박4일" required></label>
      <label class="field"><span>함께 가는 사람 (쉼표로 구분, 첫 번째가 나)</span>
        <input class="input" name="names" placeholder="지훈, 민수, 지영" required></label>
      <label class="field"><span>정산 통화</span>
        <select class="input" name="base">${CURRENCIES.map((c) => `<option ${c === 'KRW' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <button class="btn primary block">여행방 만들기</button>
    </form>
    ${recent.length ? `<div class="card recent" style="margin-top:16px"><b>최근 여행방</b>
      ${recent.map((t) => `<a href="#/t/${esc(t.id)}"><span>${esc(t.name)}</span><span class="muted small">${new Date(t.at).toLocaleDateString('ko-KR')}</span></a>`).join('')}</div>` : ''}
    <p class="muted small" style="margin-top:24px">${store.mode === 'cloud'
      ? '링크를 받은 사람은 누구나 이 방을 보고 입력할 수 있어요. 방은 마지막 사용 후 90일 뒤 정리돼요.'
      : '로컬 모드: 이 기기에만 저장돼요. 공유 링크에는 그 시점의 내용이 담겨요.'}
      · <a href="privacy.html">개인정보처리방침</a></p>`;

  $app.querySelector('#create').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const names = [...new Set(String(f.get('names')).split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
    if (!names.length) return toast('함께 가는 사람을 적어 주세요');
    if (names.length > 30) return toast('최대 30명까지예요');
    e.target.querySelector('button').disabled = true;
    try {
      const t = await store.createTrip({ name: String(f.get('name')).trim(), baseCurrency: f.get('base'), names });
      me.set(t.id, t.participants[0].id);
      location.hash = `#/t/${t.id}`;
    } catch (err) { toast(err.message); e.target.querySelector('button').disabled = false; }
  };
}

// ───────── 스냅샷 가져오기 (로컬 모드 공유) ─────────
async function importSnapshot(data) {
  try {
    const t = await decodeSnapshot(data);
    if (!t?.id || !Array.isArray(t.participants)) throw new Error('bad');
    if (store.mode === 'local') await store.importSnapshot(t);
    location.replace(`#/t/${t.id}`);
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
    $app.innerHTML = `<div class="empty">${esc(e.message)}<br><br><a href="#/">처음으로</a></div>`;
    return;
  }
  view.unsub = store.subscribe(id, async () => {
    try { view.trip = await store.getTrip(id); renderTrip(); } catch { /* 일시 오류 무시 */ }
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
        <button class="btn sm primary" id="share">초대</button>
      </div>
      <nav class="tabs" role="tablist">${tabs.map(([k, l]) =>
        `<button role="tab" aria-selected="${view.tab === k}" data-tab="${k}">${l}</button>`).join('')}</nav>
    </header>
    <div class="summary">
      <div class="card"><span class="muted small">총 지출</span><b class="num">${fmt(result.balances.reduce((a, b) => a + b.paid, 0), t.baseCurrency)}</b></div>
      <div class="card"><span class="muted small">${!mine ? '나' : `${esc(nameOf(t, myId))}님 ${mine.net > 0 ? '받을 돈' : mine.net < 0 ? '낼 돈' : ''}`}</span>
        <b class="num ${mine?.net > 0 ? 'plus' : mine?.net < 0 ? 'minus' : ''}">${!mine ? '—'
          : mine.net ? fmt(Math.abs(mine.net), t.baseCurrency) : '정산 0원'}</b></div>
    </div>
    <main id="tab-body"></main>
    ${view.tab === 'list' ? '<button class="fab" id="add">＋ 지출</button>' : ''}`;

  $app.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { location.hash = `#/t/${t.id}${b.dataset.tab === 'list' ? '' : '/' + b.dataset.tab}`; };
  });
  $app.querySelector('#share').onclick = () => shareTrip(t);
  const add = $app.querySelector('#add');
  if (add) add.onclick = () => expenseSheet();

  const body = $app.querySelector('#tab-body');
  if (view.tab === 'settle') renderSettle(body, t, result);
  else if (view.tab === 'people') renderPeople(body, t);
  else renderList(body, t);
}

function renderList(body, t) {
  const q = view.q.trim().toLowerCase();
  const live = t.expenses.filter((e) => !e.deletedAt);
  const list = live
    .filter((e) => !q || e.title.toLowerCase().includes(q) || nameOf(t, e.payerId).toLowerCase().includes(q))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const byCur = {};
  live.forEach((e) => { byCur[e.currency] = (byCur[e.currency] || 0) + Number(e.amount); });
  const curLine = Object.keys(byCur).length > 1
    ? `<p class="muted small">통화별 합계: ${Object.entries(byCur).map(([c, v]) => fmtMajor(v, c)).join(' · ')}</p>` : '';

  let lastDay = '';
  body.innerHTML = `
    ${live.length > 4 ? `<input class="input" id="q" type="search" placeholder="검색 (내용·낸 사람)" value="${esc(view.q)}">` : ''}
    ${curLine}
    ${!live.length ? `<div class="empty">아직 지출이 없어요.<br>아래 <b>＋ 지출</b>로 첫 항목을 넣어 보세요.</div>` : ''}
    ${list.map((e) => {
      const day = e.date !== lastDay ? `<div class="day">${esc(e.date)}</div>` : '';
      lastDay = e.date;
      let baseLine = '';
      if (e.currency !== t.baseCurrency) {
        try { baseLine = `<div class="muted small num">≈ ${fmt(expenseBaseMinor(e, t.baseCurrency), t.baseCurrency)}</div>`; } catch { baseLine = '<div class="minus small">환율 필요</div>'; }
      }
      const who = e.shares.length === t.participants.length ? '전원' : `${e.shares.length}명`;
      return `${day}<div class="exp" data-eid="${esc(e.id)}">
        <div class="grow"><div class="t">${esc(e.title)}</div>
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
}

function renderSettle(body, t, result) {
  const cur = t.baseCurrency;
  body.innerHTML = `
    <div class="card">
      <div class="row between"><b>보낼 돈 ${result.transfers.length}건</b>
        <span class="muted small">${result.optimal ? '최소 이체' : '간소화 이체'}</span></div>
      ${!result.transfers.length ? '<div class="empty">보낼 돈이 없어요 🎉</div>' : ''}
      ${result.transfers.map((x, i) => {
        const links = transferLinks(t.participants.find((p) => p.id === x.to), x.amount, cur);
        return `<div class="xfer">
          <span class="who">${esc(nameOf(t, x.from))}</span><span class="muted">→</span><span class="who">${esc(nameOf(t, x.to))}</span>
          <span class="amt num">${fmt(x.amount, cur)}</span>
          <div class="links">
            <button class="btn sm ghost" data-copy-amt="${i}">금액 복사</button>
            ${links.map((l, j) => l.href
              ? `<a class="btn sm ghost" href="${esc(l.href)}" target="_blank" rel="noopener" data-paylink="${l.kind}">${l.label}${l.over ? ' (한도 30만)' : ''}</a>`
              : `<button class="btn sm ghost" data-copy-acc="${i}:${j}">${l.label}</button>`).join('')}
            ${!links.length ? `<span class="muted small">${esc(nameOf(t, x.to))}님이 멤버 탭에 송금 정보를 넣으면 버튼이 생겨요</span>` : ''}
          </div></div>`;
      }).join('')}
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary grow" id="share-text">카톡용 복사</button>
      <button class="btn grow" id="share-img">이미지로 공유</button>
    </div>
    <details class="card" style="margin-top:12px"><summary>계산 근거 보기</summary>
      <table class="basis num"><thead><tr><th>이름</th><th>낸 돈</th><th>쓴 몫</th><th>차액</th></tr></thead><tbody>
      ${result.balances.map((b) => `<tr><td>${esc(nameOf(t, b.pid))}</td><td>${fmt(b.paid, cur)}</td><td>${fmt(b.owed, cur)}</td>
        <td class="${b.net > 0 ? 'plus' : b.net < 0 ? 'minus' : ''}">${b.net > 0 ? '+' : ''}${fmt(b.net, cur)}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted small">외화 지출은 입력한 환율(또는 카드 청구액)로 ${cur} 환산. 나누어 떨어지지 않는 1${cur === 'KRW' ? '원' : ' 단위'}은 목록 앞사람이 냅니다.</p>
    </details>
    ${isAdmin(t) ? `<button class="btn ghost block" id="mark" style="margin-top:12px">${t.settledAt ? '정산 완료 취소' : '정산 완료로 표시'}</button>` : ''}`;

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
  body.querySelector('#share-text').onclick = () => {
    copy(settlementText(t, result, (pid) => nameOf(t, pid)), '정산표를 복사했어요. 카톡에 붙여 넣으세요');
    store.logEvent(t.id, 'settle_shared', { via: 'text' });
  };
  body.querySelector('#share-img').onclick = async () => {
    const blob = await settlementImage(t, result, (pid) => nameOf(t, pid));
    const file = new File([blob], `${t.name}-정산.png`, { type: 'image/png' });
    store.logEvent(t.id, 'settle_shared', { via: 'image' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: `${t.name} 정산` }); return; } catch { /* 취소 → 다운로드로 */ }
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const mark = body.querySelector('#mark');
  if (mark) mark.onclick = async () => {
    try { await store.markSettled(t.id, !t.settledAt); view.trip = await store.getTrip(t.id); renderTrip(); }
    catch (e) { toast(e.message); }
  };
}

function renderPeople(body, t) {
  const myId = me.get(t.id);
  body.innerHTML = `
    <div class="card">
      ${t.participants.map((p) => {
        const i = p.payInfo || {};
        const has = [i.toss && '토스', i.kakao && '카카오페이', i.account && '계좌'].filter(Boolean).join('·');
        return `<div class="exp" data-pid="${esc(p.id)}"><div class="grow"><div class="t">${esc(p.name)}${p.id === myId ? ' <span class="badge">나</span>' : ''}</div>
          <div class="muted small">${has ? `송금 정보: ${has}` : '송금 정보 없음'}</div></div>
          ${p.id === myId ? '<span class="btn sm">내 정보</span>' : ''}</div>`;
      }).join('')}
      <form id="addp" class="row" style="margin-top:12px">
        <input class="input grow" name="n" maxlength="30" placeholder="사람 추가">
        <button class="btn">추가</button></form>
    </div>
    <button class="btn ghost block" id="whoami" style="margin-top:12px">내가 누구인지 다시 고르기</button>`;
  body.querySelectorAll('[data-pid]').forEach((el) => {
    if (el.dataset.pid === myId) el.onclick = () => payInfoSheet(t.participants.find((p) => p.id === myId));
  });
  body.querySelector('#addp').onsubmit = async (e) => {
    e.preventDefault();
    const n = new FormData(e.target).get('n').trim();
    if (!n) return;
    if (t.participants.some((p) => p.name === n)) return toast('같은 이름이 이미 있어요');
    try { await store.addParticipant(t.id, n); view.trip = await store.getTrip(t.id); renderTrip(); }
    catch (err) { toast(err.message); }
  };
  body.querySelector('#whoami').onclick = () => pickIdentity();
}

// ───────── 시트 ─────────
function openSheet(html, onMount) {
  $sheet.innerHTML = `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const scrim = $sheet.querySelector('.scrim');
  scrim.addEventListener('click', (e) => { if (e.target === scrim && !scrim.dataset.locked) closeSheet(); });
  onMount($sheet.querySelector('.sheet'), scrim);
}
function closeSheet() { $sheet.innerHTML = ''; }

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
      try { const p = await store.addParticipant(t.id, n); view.trip = await store.getTrip(t.id); done(p.id); }
      catch (err) { toast(err.message); }
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
      catch (err) { toast(err.message); }
    };
  });
}

function expenseSheet(exp) {
  const t = view.trip;
  const myId = me.get(t.id);
  const editing = !!exp;
  const canEdit = !editing || exp.device === deviceId() || isAdmin(t);
  const e = exp || {
    title: '', date: today(), amount: '', currency: lastCurrency(t), rate: '', baseOverride: '',
    payerId: myId || t.participants[0].id, shares: t.participants.map((p) => ({ pid: p.id, w: 1 })),
  };
  const sel = new Set(e.shares.map((s) => s.pid));

  openSheet(`
    <h2>${editing ? '지출 수정' : '지출 추가'}</h2>
    <form class="stack" id="ef">
      <label class="field"><span>내용</span><input class="input" name="title" maxlength="100" value="${esc(e.title)}" placeholder="예: 저녁 이자카야" required></label>
      <div class="row">
        <label class="field grow"><span>금액</span><input class="input num" name="amount" inputmode="decimal" value="${esc(e.amount)}" placeholder="0" required></label>
        <label class="field" style="width:110px"><span>통화</span><select class="input" name="currency">${CURRENCIES.map((c) => `<option ${c === e.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <div id="fx" class="card stack ${e.currency === t.baseCurrency ? 'hidden' : ''}" style="background:var(--surface-2)">
        <label class="field"><span id="rate-label">환율</span><input class="input num" name="rate" inputmode="decimal" value="${esc(e.rate)}"></label>
        <label class="field"><span>실제 카드 청구액 (${t.baseCurrency}, 선택 — 넣으면 환율보다 우선)</span><input class="input num" name="baseOverride" inputmode="decimal" value="${esc(e.baseOverride ?? '')}"></label>
        <p class="muted small" id="fx-note"></p>
      </div>
      <div class="row">
        <label class="field grow"><span>낸 사람</span><select class="input" name="payerId">${t.participants.map((p) => `<option value="${esc(p.id)}" ${p.id === e.payerId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field" style="width:150px"><span>날짜</span><input class="input" type="date" name="date" value="${esc(e.date)}"></label>
      </div>
      <div class="field"><span class="muted small" style="font-weight:600">누구 몫? <button type="button" class="btn sm ghost" id="all">전원</button></span>
        <div class="chips" id="shares" style="margin-top:6px">${t.participants.map((p) => `<button type="button" class="chip" data-pid="${esc(p.id)}" aria-pressed="${sel.has(p.id)}">${esc(p.name)}</button>`).join('')}</div>
        <p class="muted small" id="per"></p></div>
      ${canEdit ? '' : '<p class="minus small">이 지출은 입력한 사람이나 총무만 고칠 수 있어요.</p>'}
      <div class="row">
        ${editing && canEdit ? '<button type="button" class="btn ghost" id="del">삭제</button>' : ''}
        <button type="button" class="btn grow" id="cancel">닫기</button>
        ${canEdit ? `<button class="btn primary grow">${editing ? '저장' : '추가'}</button>` : ''}
      </div>
    </form>`, (el) => {
    const f = el.querySelector('#ef');
    const fx = el.querySelector('#fx');
    const per = el.querySelector('#per');

    const updatePer = () => {
      const amt = parseAmount(f.amount.value);
      per.textContent = sel.size && amt > 0 ? `1인당 약 ${fmtMajor(amt / sel.size, f.currency.value)}` : sel.size ? '' : '한 명 이상 골라 주세요';
    };
    const updateFx = async () => {
      const cur = f.currency.value;
      fx.classList.toggle('hidden', cur === t.baseCurrency);
      el.querySelector('#rate-label').textContent = `환율 (1 ${cur} = ? ${t.baseCurrency})`;
      if (cur === t.baseCurrency) return;
      const note = el.querySelector('#fx-note');
      if (!f.rate.value || f.dataset.autoRateFor !== cur) {
        note.textContent = '환율 불러오는 중…';
        const r = await getRate(cur, t.baseCurrency);
        if (r) {
          if (!editing || f.dataset.autoRateFor) f.rate.value = r.rate;
          f.dataset.autoRateFor = cur;
          note.innerHTML = `오늘 기준 참고 환율(${esc(r.date)}). 실제 카드 환율과 다를 수 있어요. <a href="${RATE_ATTRIBUTION.href}" target="_blank" rel="noopener">${RATE_ATTRIBUTION.text}</a>`;
        } else note.textContent = '환율을 못 불러왔어요. 직접 입력해 주세요.';
      }
    };
    if (editing) f.dataset.autoRateFor = e.currency;
    f.currency.onchange = () => { f.dataset.autoRateFor = ''; f.rate.value = ''; updateFx(); updatePer(); };
    f.amount.oninput = updatePer;
    el.querySelectorAll('#shares [data-pid]').forEach((b) => {
      b.onclick = () => {
        sel.has(b.dataset.pid) ? sel.delete(b.dataset.pid) : sel.add(b.dataset.pid);
        b.setAttribute('aria-pressed', sel.has(b.dataset.pid));
        updatePer();
      };
    });
    el.querySelector('#all').onclick = () => {
      t.participants.forEach((p) => sel.add(p.id));
      el.querySelectorAll('#shares [data-pid]').forEach((b) => b.setAttribute('aria-pressed', 'true'));
      updatePer();
    };
    el.querySelector('#cancel').onclick = closeSheet;
    const del = el.querySelector('#del');
    if (del) del.onclick = async () => {
      if (!confirm('이 지출을 지울까요?')) return;
      try { await store.deleteExpense(t.id, exp.id); view.trip = await store.getTrip(t.id); closeSheet(); renderTrip(); toast('지웠어요'); }
      catch (err) { toast(err.message); }
    };
    updateFx(); updatePer();

    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const amount = parseAmount(f.amount.value);
      if (!(amount > 0)) return toast('금액을 확인해 주세요');
      if (!sel.size) return toast('누구 몫인지 한 명 이상 골라 주세요');
      const cur = f.currency.value;
      const data = {
        title: f.title.value.trim(), date: f.date.value || today(), amount, currency: cur,
        rate: cur === t.baseCurrency ? null : parseAmount(f.rate.value) || null,
        baseOverride: cur === t.baseCurrency || !f.baseOverride.value.trim() ? null : parseAmount(f.baseOverride.value),
        payerId: f.payerId.value,
        // 참여자 목록 순서 유지 — 1원 배분 순서가 기기마다 같아야 한다
        shares: t.participants.filter((p) => sel.has(p.id)).map((p) => ({ pid: p.id, w: 1 })),
      };
      if (cur !== t.baseCurrency && !data.rate && data.baseOverride == null) return toast('환율이나 카드 청구액을 넣어 주세요');
      try {
        if (editing) await store.updateExpense(t.id, exp.id, data);
        else await store.addExpense(t.id, data);
        try { localStorage.setItem(`enbbang:lastcur:${t.id}`, cur); } catch { /* 무시 */ }
        view.trip = await store.getTrip(t.id);
        closeSheet(); renderTrip();
        toast(editing ? '저장했어요' : '추가했어요');
      } catch (err) { toast(err.message); }
    };
  });
}

function lastCurrency(t) {
  try { return localStorage.getItem(`enbbang:lastcur:${t.id}`) || t.baseCurrency; } catch { return t.baseCurrency; }
}

// ───────── 초대(공유) ─────────
async function shareTrip(t) {
  const base = location.href.split('#')[0];
  const url = store.mode === 'cloud' ? `${base}#/t/${t.id}` : `${base}#/s/${await encodeSnapshot(t)}`;
  const text = `✈️ ${t.name} 정산방이에요. 쓴 돈 여기에 같이 적어요 (가입 없음)`;
  if (navigator.share) {
    try { await navigator.share({ title: t.name, text, url }); return; } catch { /* 취소 → 복사 */ }
  }
  copy(`${text}\n${url}`, store.mode === 'cloud' ? '초대 링크를 복사했어요' : '현재 상태 링크를 복사했어요');
}

// ───────── 시작 ─────────
(async () => {
  store = await createStore(window.ENBBANG_CONFIG);
  window.__enbbang = { store }; // 디버깅용
  addEventListener('hashchange', route);
  route();
})();
