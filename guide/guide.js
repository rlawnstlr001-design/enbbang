// 여행지별 정산 안내: 오늘의 참고 환율 한 줄 (실패하면 조용히 숨김). 출처 표기는 환율 API 조건
(async () => {
  const el = document.getElementById('live-rate');
  if (!el) return;
  const cur = el.dataset.cur;
  const unit = Number(el.dataset.unit) || 1;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/KRW');
    const j = await r.json();
    const perKrw = j?.rates?.[cur];
    if (j.result !== 'success' || !perKrw) return;
    const krw = Math.round(unit / perKrw);
    const d = new Date(j.time_last_update_utc);
    const day = isNaN(d) ? '' : ` (${d.getMonth() + 1}/${d.getDate()} 기준)`;
    el.innerHTML = `오늘 참고 환율: ${unit.toLocaleString('ko-KR')} ${cur} = 약 ${krw.toLocaleString('ko-KR')}원${day} · <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener">Rates By Exchange Rate API</a>`;
    el.hidden = false;
  } catch { /* 환율을 못 불러와도 예시는 그대로 */ }
})();
