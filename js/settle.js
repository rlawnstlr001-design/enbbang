// 엔빵 정산 코어 — 순수 함수만. UI·저장소 의존 없음 (node 테스트 대상)
// 금액은 모두 "기준 통화의 최소 단위 정수"로 계산한다 (KRW=1원, USD=1센트).

export const CURRENCY_DECIMALS = {
  KRW: 0, JPY: 0, VND: 0, TWD: 0, IDR: 0,
  USD: 2, EUR: 2, GBP: 2, CNY: 2, HKD: 2, SGD: 2, THB: 2, PHP: 2,
  AUD: 2, CAD: 2, CHF: 2, MYR: 2, NZD: 2,
};

export function decimalsOf(cur) {
  return CURRENCY_DECIMALS[cur] ?? 2;
}

export function toMinor(major, cur) {
  return Math.round(Number(major) * 10 ** decimalsOf(cur));
}

export function fromMinor(minor, cur) {
  return minor / 10 ** decimalsOf(cur);
}

// 지출 1건을 기준 통화 최소 단위로 환산.
// rate = 기준통화 1단위가 아니라 "외화 1단위 = 기준통화 몇" (예: 1 JPY = 9.1 KRW)
// baseOverride = 실제 카드 청구액(기준통화, major) — 있으면 환율 계산보다 우선
export function expenseBaseMinor(exp, baseCur) {
  if (exp.baseOverride != null && exp.baseOverride !== '') {
    return toMinor(exp.baseOverride, baseCur);
  }
  if (exp.currency === baseCur) return toMinor(exp.amount, baseCur);
  const rate = Number(exp.rate);
  if (!(rate > 0)) throw new Error(`환율 없음: ${exp.currency}`);
  return Math.round(Number(exp.amount) * rate * 10 ** decimalsOf(baseCur));
}

// 정수 total을 가중치대로 나눈다 (최대 잔여법). 합계가 정확히 total이 되도록 보장.
// 동률은 입력 순서가 앞선 사람이 1원을 더 낸다 — 결정적이어야 재계산해도 결과가 같다.
export function splitMinor(total, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) throw new Error('분배 대상 없음');
  const raw = weights.map((w) => (total * w) / sumW);
  const base = raw.map((x) => Math.floor(x));
  let rest = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) base[order[k].i] += 1;
  return base;
}

// 참여자별 순잔액: + 는 받을 돈, - 는 낼 돈. 합은 항상 0.
export function computeBalances(trip) {
  const base = trip.baseCurrency;
  const bal = new Map(trip.participants.map((p) => [p.id, { paid: 0, owed: 0 }]));
  for (const exp of trip.expenses) {
    if (exp.deletedAt || exp.kind === 'transfer') continue;
    const shares = (exp.shares || []).filter((s) => bal.has(s.pid) && s.w > 0);
    if (!shares.length || !bal.has(exp.payerId)) continue;
    const total = expenseBaseMinor(exp, base);
    const parts = splitMinor(total, shares.map((s) => s.w));
    bal.get(exp.payerId).paid += total;
    shares.forEach((s, i) => { bal.get(s.pid).owed += parts[i]; });
  }
  return trip.participants.map((p) => {
    const b = bal.get(p.id);
    return { pid: p.id, paid: b.paid, owed: b.owed, net: b.paid - b.owed };
  });
}

// 0합 집합 하나를 그리디로 정리 — 집합 크기 k면 이체는 최대 k-1번.
function greedySettle(items) {
  const cred = items.filter((x) => x.amt > 0).map((x) => ({ ...x }));
  const debt = items.filter((x) => x.amt < 0).map((x) => ({ pid: x.pid, amt: -x.amt }));
  cred.sort((a, b) => b.amt - a.amt);
  debt.sort((a, b) => b.amt - a.amt);
  const out = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const m = Math.min(debt[i].amt, cred[j].amt);
    if (m > 0) out.push({ from: debt[i].pid, to: cred[j].pid, amount: m });
    debt[i].amt -= m;
    cred[j].amt -= m;
    if (debt[i].amt === 0) i++;
    if (cred[j].amt === 0) j++;
  }
  return out;
}

// 최소 이체 횟수 = (0 아닌 사람 수) − (서로소 0합 부분집합의 최대 개수).
// 16명 이하는 비트마스크 DP로 최적해, 그 이상은 그리디(최대 n−1번).
export const OPTIMAL_LIMIT = 16;

export function minTransfers(balances) {
  const items = balances.filter((b) => b.net !== 0).map((b) => ({ pid: b.pid, amt: b.net }));
  const n = items.length;
  if (n === 0) return { transfers: [], optimal: true };
  if (n > OPTIMAL_LIMIT) return { transfers: greedySettle(items), optimal: false };

  const full = (1 << n) - 1;
  const sum = new Float64Array(1 << n);
  for (let m = 1; m <= full; m++) {
    const low = m & -m;
    sum[m] = sum[m ^ low] + items[31 - Math.clz32(low)].amt;
  }
  const dp = new Int16Array(1 << n);
  for (let m = 1; m <= full; m++) {
    let best = 0;
    for (let k = 0; k < n; k++) if (m & (1 << k)) best = Math.max(best, dp[m ^ (1 << k)]);
    dp[m] = best + (sum[m] === 0 ? 1 : 0);
  }

  // 역추적: full → 0 으로 원소를 하나씩 빼며, 합이 0인 지점에서 그룹을 끊는다.
  const groups = [];
  let cur = [];
  let m = full;
  while (m) {
    const gain = sum[m] === 0 ? 1 : 0;
    let pick = -1;
    for (let k = 0; k < n; k++) {
      if ((m & (1 << k)) && dp[m ^ (1 << k)] + gain === dp[m]) { pick = k; break; }
    }
    cur.push(items[pick]);
    m ^= 1 << pick;
    if (sum[m] === 0) { groups.push(cur); cur = []; }
  }
  const transfers = groups.flatMap(greedySettle);
  transfers.sort((a, b) => b.amount - a.amount);
  return { transfers, optimal: true };
}

// "낸 사람에게 직접 갚기" — 지출마다 생긴 빚을 사람 쌍별로 상계만 한다(제3자 경유 없음).
export function directTransfers(trip, pays = []) {
  const base = trip.baseCurrency;
  const ids = new Set(trip.participants.map((p) => p.id));
  const debt = new Map(); // "a>b" → a가 b에게 줄 돈
  const add = (a, b, v) => { const k = `${a}>${b}`; debt.set(k, (debt.get(k) || 0) + v); };
  for (const exp of trip.expenses) {
    if (exp.deletedAt || exp.kind === 'transfer') continue;
    const shares = (exp.shares || []).filter((s) => ids.has(s.pid) && s.w > 0);
    if (!shares.length || !ids.has(exp.payerId)) continue;
    const parts = splitMinor(expenseBaseMinor(exp, base), shares.map((s) => s.w));
    shares.forEach((s, i) => { if (s.pid !== exp.payerId) add(s.pid, exp.payerId, parts[i]); });
  }
  for (const p of pays) add(p.to, p.from, p.amount); // 보낸 돈은 반대 방향 빚으로 상계
  const order = trip.participants.map((p) => p.id);
  const out = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i], b = order[j];
      const d = (debt.get(`${a}>${b}`) || 0) - (debt.get(`${b}>${a}`) || 0);
      if (d > 0) out.push({ from: a, to: b, amount: d });
      else if (d < 0) out.push({ from: b, to: a, amount: -d });
    }
  }
  return out.sort((x, y) => y.amount - x.amount);
}

// "보냈어요"로 기록된 송금 (kind='transfer' 지출: 낸 사람=보낸 사람, 대상자=받은 사람)
export function paymentsOf(trip) {
  const ids = new Set(trip.participants.map((p) => p.id));
  return trip.expenses
    .filter((e) => !e.deletedAt && e.kind === 'transfer' && ids.has(e.payerId) && ids.has(e.shares?.[0]?.pid))
    .map((e) => ({ id: e.id, from: e.payerId, to: e.shares[0].pid, amount: expenseBaseMinor(e, trip.baseCurrency) }));
}

// 정산 결과. transfers 각 항목에 done(보냈음)이 붙는다.
// 보낸 송금이 모두 제안과 정확히 일치하면 제안 목록을 그대로 두고 체크만 한다 —
// 한 건 보냈다고 나머지 제안이 뒤섞이면 사용자가 혼란스럽기 때문이다.
// 일치하지 않는 송금(금액·상대가 다름)이 섞이면 남은 잔액으로 다시 계산한다.
export function settle(trip) {
  const mode = trip.settleMode === 'direct' ? 'direct' : 'min';
  const bal0 = computeBalances(trip);
  const pays = paymentsOf(trip);
  const plan = mode === 'direct' ? { transfers: directTransfers(trip), optimal: true } : minTransfers(bal0);

  const suggestions = plan.transfers.map((t) => ({ ...t, done: false }));
  let allMatched = true;
  for (const p of pays) {
    const s = suggestions.find((x) => !x.done && x.from === p.from && x.to === p.to && x.amount === p.amount);
    if (s) { s.done = true; s.paymentId = p.id; } else allMatched = false;
  }

  const sent = new Map(), recv = new Map();
  for (const p of pays) {
    sent.set(p.from, (sent.get(p.from) || 0) + p.amount);
    recv.set(p.to, (recv.get(p.to) || 0) + p.amount);
  }
  const balances = bal0.map((b) => {
    const s = sent.get(b.pid) || 0, r = recv.get(b.pid) || 0;
    return { ...b, sent: s, received: r, net: b.net + s - r };
  });

  let transfers = suggestions;
  let optimal = plan.optimal;
  if (!allMatched) {
    const pending = mode === 'direct' ? { transfers: directTransfers(trip, pays), optimal: true } : minTransfers(balances);
    optimal = pending.optimal;
    transfers = [
      ...pending.transfers.map((t) => ({ ...t, done: false })),
      ...pays.map((p) => ({ from: p.from, to: p.to, amount: p.amount, done: true, paymentId: p.id })),
    ];
  }
  const totalSpent = bal0.reduce((a, b) => a + b.paid, 0);
  return { mode, balances, transfers, optimal, totalSpent, pending: transfers.filter((t) => !t.done) };
}
