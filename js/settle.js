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

// 여행방 이름으로 여행지 통화를 짐작한다 — 첫 지출 통화 기본값으로만 쓴다(사용자가 바꾸면 그게 우선) (10/7)
const PLACE_CURRENCY = [
  ['JPY', /일본|도쿄|동경|오사카|교토|후쿠오카|삿포로|오키나와|나고야|고베|홋카이도|규슈|유후인|벳푸|하코네|요코하마/],
  ['VND', /베트남|다낭|하노이|호치민|나트랑|냐짱|푸꾸옥|달랏|호이안|하롱/],
  ['TWD', /대만|타이베이|타이페이|가오슝|타이중|타이난/],
  ['THB', /태국|방콕|치앙마이|푸켓|파타야|끄라비/],
  ['PHP', /필리핀|세부|보라카이|마닐라|보홀|클락/],
  ['IDR', /인도네시아|발리|자카르타|롬복/],
  ['MYR', /말레이시아|쿠알라룸푸르|코타키나발루|페낭|랑카위/],
  ['SGD', /싱가포르/],
  ['HKD', /홍콩|마카오/],
  ['CNY', /중국|상하이|베이징|북경|칭다오|장가계|하얼빈|청두/],
  ['USD', /미국|뉴욕|하와이|괌|사이판|라스베이?가스|샌프란|로스앤젤레스|엘에이|LA/],
  ['CAD', /캐나다|밴쿠버|토론토|몬트리올/],
  ['GBP', /영국|런던|에든버러/],
  ['CHF', /스위스|취리히|인터라켄|제네바/],
  ['EUR', /유럽|프랑스|파리|이탈리아|로마|피렌체|베네치아|스페인|바르셀로나|마드리드|독일|뮌헨|베를린|포르투갈|리스본|포르투|오스트리아|비엔나|네덜란드|암스테르담|그리스|아테네|체코|프라하|크로아티아/],
  ['AUD', /호주|시드니|멜버른|브리즈번|골드코스트/],
  ['NZD', /뉴질랜드|오클랜드|퀸스타운/],
];
export function guessCurrency(name) {
  const s = String(name || '');
  return PLACE_CURRENCY.find(([, re]) => re.test(s))?.[0] || null;
}

// 서버에서 받은 방 데이터를 화면·계산이 믿고 쓸 모양으로 정리한다.
// 예전 앱·끊긴 요청으로 모양이 깨진 지출 한 건 때문에 방 전체가 안 열리는 일을 막는다 (10/7)
export function tidyTrip(trip) {
  if (!trip || typeof trip !== 'object') return trip;
  const participants = Array.isArray(trip.participants) ? trip.participants.filter((p) => p && p.id) : [];
  const expenses = (Array.isArray(trip.expenses) ? trip.expenses : []).filter((e) => e && e.id).map((e) => ({
    ...e,
    title: typeof e.title === 'string' && e.title ? e.title : '(내용 없음)',
    date: typeof e.date === 'string' ? e.date : '',
    currency: typeof e.currency === 'string' ? e.currency.toUpperCase() : '',
    shares: Array.isArray(e.shares)
      ? e.shares.filter((s) => s && typeof s.pid === 'string').map((s) => ({ ...s, w: Number(s.w) }))
      : [],
  }));
  return { ...trip, participants, expenses };
}

// 계산에 쓸 수 있는 지출인지 — 금액·환율이 숫자이고 나눌 사람이 있어야 한다
export function isUsable(exp, baseCur) {
  if (!Array.isArray(exp.shares) || !exp.shares.some((s) => Number.isFinite(s.w) && s.w > 0)) return false;
  if (!/^[A-Z]{3}$/.test(exp.currency || '')) return false;
  try {
    const v = expenseBaseMinor(exp, baseCur);
    return Number.isFinite(v) && v >= 0;
  } catch { return false; }
}

// 계산에서 뺀 지출(지우지 않은 것만) — 화면에 "고쳐 주세요"로 알린다
export function brokenExpenses(trip) {
  return trip.expenses.filter((e) => !e.deletedAt && !isUsable(e, trip.baseCurrency));
}

const usableShares = (exp, ids) => exp.shares.filter((s) => ids.has(s.pid) && Number.isFinite(s.w) && s.w > 0);

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
    if (exp.deletedAt || exp.kind === 'transfer' || !isUsable(exp, base)) continue;
    const shares = usableShares(exp, bal);
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

// ───── 카테고리 ─────
export const CATEGORIES = [
  { id: 'food', emoji: '🍜', label: '식비' },
  { id: 'transport', emoji: '🚕', label: '교통' },
  { id: 'stay', emoji: '🏨', label: '숙소' },
  { id: 'activity', emoji: '🎫', label: '관광' },
  { id: 'shopping', emoji: '🛍', label: '쇼핑' },
  { id: 'etc', emoji: '✨', label: '기타' },
];

const CAT_WORDS = {
  transport: /택시|버스|지하철|전철|기차|ktx|srt|열차|렌터카|렌트|주유|기름|톨게이트|통행료|주차|항공|비행기|공항|페리|배편|스이카|교통|taxi|uber|grab|train|bus/i,
  stay: /호텔|숙소|숙박|에어비앤비|airbnb|펜션|게스트하우스|게하|리조트|료칸|모텔|민박|hotel|hostel/i,
  food: /식|밥|저녁|점심|아침|브런치|카페|커피|술|맥주|소주|와인|이자카야|라멘|스시|초밥|고기|삼겹|치킨|피자|간식|디저트|빵|편의점|마트|장보|음료|food|dinner|lunch|cafe|beer/i,
  activity: /입장|티켓|투어|관광|체험|박물관|미술관|공연|테마파크|유니버설|디즈니|액티비티|스노클|다이빙|온천|입장료|ticket|tour/i,
  shopping: /쇼핑|면세|기념품|선물|옷|화장품|돈키|드럭|아울렛|shopping|souvenir/i,
};

// 내용으로 카테고리 추측 (사용자가 직접 고르면 그게 우선)
export function guessCategory(title) {
  for (const id of ['transport', 'stay', 'activity', 'shopping', 'food']) {
    if (CAT_WORDS[id].test(title || '')) return id;
  }
  return null;
}

// 카테고리별 지출 합계(기준 통화 최소 단위). 송금 기록은 제외.
export function categoryTotals(trip) {
  const sums = new Map();
  for (const e of trip.expenses) {
    if (e.deletedAt || e.kind === 'transfer') continue;
    let v;
    try { v = expenseBaseMinor(e, trip.baseCurrency); } catch { continue; }
    const k = e.category || 'etc';
    sums.set(k, (sums.get(k) || 0) + v);
  }
  return CATEGORIES.filter((c) => sums.has(c.id)).map((c) => ({ ...c, total: sums.get(c.id) }))
    .sort((a, b) => b.total - a.total);
}

// "낸 사람에게 직접 갚기" — 지출마다 생긴 빚을 사람 쌍별로 상계만 한다(제3자 경유 없음).
export function directTransfers(trip, pays = []) {
  const base = trip.baseCurrency;
  const ids = new Set(trip.participants.map((p) => p.id));
  const debt = new Map(); // "a>b" → a가 b에게 줄 돈
  const add = (a, b, v) => { const k = `${a}>${b}`; debt.set(k, (debt.get(k) || 0) + v); };
  for (const exp of trip.expenses) {
    if (exp.deletedAt || exp.kind === 'transfer' || !isUsable(exp, base)) continue;
    const shares = usableShares(exp, ids);
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
    .filter((e) => !e.deletedAt && e.kind === 'transfer' && ids.has(e.payerId) && ids.has(e.shares?.[0]?.pid)
      && isUsable(e, trip.baseCurrency))
    .map((e) => ({ id: e.id, from: e.payerId, to: e.shares[0].pid, amount: expenseBaseMinor(e, trip.baseCurrency) }));
}

// "보냈어요" 한 번에 붙는 표시(cid). 같은 송금을 두 사람이 동시에, 또는 오래된 화면에서 눌러도
// 같은 표시가 나오므로 서버가 한 건만 남긴다(009). 보낸 사람·받는 사람·금액·이미 기록된 같은 쌍 송금 수로 정한다.
export function transferKey(trip, x) {
  const n = trip.expenses.filter((e) => !e.deletedAt && e.kind === 'transfer'
    && e.payerId === x.from && e.shares?.[0]?.pid === x.to).length;
  const s = `${trip.id}|${x.from}|${x.to}|${x.amount}|${n}`;
  const fnv = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  };
  return `tmp_x${fnv(s)}${fnv(`${s}#`)}`;
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
