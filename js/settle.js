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
    if (exp.deletedAt) continue;
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

export function settle(trip) {
  const balances = computeBalances(trip);
  return { balances, ...minTransfers(balances) };
}
