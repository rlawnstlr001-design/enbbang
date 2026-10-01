// 환율 — open.er-api.com 무료 엔드포인트(하루 1회 갱신, 출처 표기 의무, 재배포 금지).
// 하루 단위로 기기에 캐시한다. 실패하면 null → 사용자가 직접 입력.

export const RATE_ATTRIBUTION = { text: 'Rates By Exchange Rate API', href: 'https://www.exchangerate-api.com' };

const memo = new Map();

// 반환: 외화 1단위 = 기준통화 몇 (예: getRate('JPY','KRW') → 9.12)
export async function getRate(cur, base) {
  if (cur === base) return { rate: 1, date: null };
  const today = new Date().toISOString().slice(0, 10);
  const key = `enbbang:rates:${base}:${today}`;
  let table = memo.get(key);
  if (!table) {
    try { table = JSON.parse(localStorage.getItem(key) || 'null'); } catch { table = null; }
  }
  if (!table) {
    try {
      const r = await fetch(`https://open.er-api.com/v6/latest/${base}`);
      const j = await r.json();
      if (j.result !== 'success') throw new Error(j['error-type'] || 'rate error');
      table = { rates: j.rates, date: (j.time_last_update_utc || '').slice(5, 16) };
      try { localStorage.setItem(key, JSON.stringify(table)); } catch { /* 저장 실패 무시 */ }
    } catch (e) {
      console.warn('환율 조회 실패', e);
      return null;
    }
  }
  memo.set(key, table);
  const perBase = table.rates[cur]; // 기준통화 1 = 외화 perBase
  if (!perBase) return null;
  return { rate: Number((1 / perBase).toPrecision(8)), date: table.date };
}
