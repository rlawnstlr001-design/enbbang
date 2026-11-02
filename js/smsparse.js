// 카드 결제 문자 → 지출 후보 (출시 뒤 '자동 입력' 업데이트용, 10/29 초안 — 아직 화면에 연결하지 않았다)
// 테스터 의견 "카드내역 불러와 선택할 수 있으면 편하겠다"(10/16)에 대한 첫 단계.
// 안드로이드 문자 읽기 권한(READ_SMS)은 Play 정책상 기본 문자 앱만 받을 수 있다 → 사용자가 문자를 길게 눌러 복사해 붙여 넣는다.
// 여러 통을 한 번에 붙여 넣어도 나눠 읽는다. 모르는 모양은 버리지 않고 '확인 필요'로 돌려준다(사용자가 고른다).
// 실제 카드사 문자 샘플로 다시 맞춰야 한다 — 지금 규칙은 흔히 알려진 모양 기준이다.
// 10/30 준식님 실제 샘플 2종 반영: ①은행 출금 "[신한은행]10/13 23:45:40 [110-***-…] 출금 350,000원 (받는 사람)"
//   ②지역상품권 "[신협] 10/29 22:09 여수지역상품권 사용금액22,350원" — 둘 다 카드 '승인' 문자가 아니다.
//   kind로 구분해 돌려준다: card(카드 승인) · withdraw(계좌 출금 — 11/2 준식님: 체크카드로 결제해도 가게 이름 없이 금액만 온다. 괄호 안은 사람 이름이라 가게로 쓰지 않는다) · voucher(지역상품권·지역화폐)

const CARDS = ['KB국민', '국민', 'KB', '신한', '현대', '삼성', '롯데', '하나', '우리', 'BC', '비씨', 'NH농협', '농협', 'NH',
  '씨티', 'IBK', '기업', '카카오뱅크', '카카오', '토스뱅크', '토스', '케이뱅크', '수협', '광주', '전북', '제주', '신협', '우체국'];
const CUR_WORD = { 원: 'KRW', 엔: 'JPY', 달러: 'USD', 유로: 'EUR', 위안: 'CNY', 바트: 'THB', 동: 'VND', 페소: 'PHP' };
const NOISE = /누적|잔액|잔여|한도|일시불|할부|체크|승인|취소|거절|사용|결제|해외|국내|출금|님$|^\[?web발신\]?$|^\[?국제발신\]?$|^\(?광고\)?/i;
const VOUCHER = /([가-힣]{1,8}(?:지역상품권|사랑상품권|지역화폐|페이|상품권))/; // 여수지역상품권·○○사랑상품권 등

// 붙여 넣은 글을 문자 한 통씩으로 나눈다: [Web발신]·[국제발신] 표시, 빈 줄, 또는 카드 이름으로 시작하는 줄
export function splitMessages(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const parts = t.split(/\n\s*\n|(?=\[(?:Web|웹|국제)발신\])/i).map((s) => s.trim()).filter(Boolean);
  // 빈 줄 없이 이어 붙인 경우: "…승인" 문자가 두 번 이상 나오면 카드 이름 줄에서 다시 자른다
  const out = [];
  // 다음 문자의 첫 줄: "신한카드…승인" 또는 "[신한은행]10/13 …"·"[신협] 10/29 …"처럼 [보낸 곳] 뒤에 날짜
  const cardStart = new RegExp(`(?:^|\\n)(?=\\[?(?:${CARDS.join('|')})[^\\n]{0,12}(?:승인|취소|체크)|\\[[^\\]\\n]{2,10}\\]\\s*\\d{1,2}/\\d{1,2})`);
  for (const p of parts) {
    const hits = p.replace(/승인\s*취소/g, '취소').match(/승인|취소|출금|사용금액/g) || []; // '승인취소'는 한 통
    if (hits.length > 1) out.push(...p.split(cardStart).map((s) => s.trim()).filter((s) => s && !/^\[(?:Web|웹|국제)발신\]$/i.test(s)));
    else out.push(p);
  }
  return out;
}

function parseAmount(s) {
  // 외화: "USD 25.00", "25.00 USD", "JPY 1,500", "1,500엔" / 원화: "12,500원"
  let m = s.match(/\b([A-Z]{3})\s*([\d,]+(?:\.\d{1,2})?)\b/) || null;
  if (m && m[1] !== 'KRW' && !/^(WEB|SMS|MMS|ATM)$/.test(m[1])) return { currency: m[1], amount: num(m[2]), at: m.index, len: m[0].length };
  m = s.match(/([\d,]+(?:\.\d{1,2})?)\s*([A-Z]{3})\b/);
  if (m && m[2] !== 'KRW' && !/^(WEB|SMS|MMS|ATM)$/.test(m[2])) return { currency: m[2], amount: num(m[1]), at: m.index, len: m[0].length };
  m = s.match(/([\d,]+(?:\.\d{1,2})?)\s*(원|엔|달러|유로|위안|바트|페소)/);
  if (m) return { currency: CUR_WORD[m[2]], amount: num(m[1]), at: m.index, len: m[0].length };
  return null;
}
const num = (s) => Number(String(s).replace(/,/g, ''));

function parseWhen(s, year) {
  const m = s.match(/(\d{1,2})[/.-](\d{1,2})\s*(?:\([^)]*\))?\s*(\d{1,2}):(\d{2})/) || s.match(/(\d{1,2})[/.-](\d{1,2})(?!\d)/);
  if (!m) return null;
  const mo = +m[1], d = +m[2];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return {
    date: `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    time: m[3] != null ? `${String(+m[3]).padStart(2, '0')}:${m[4]}` : null,
    at: m.index, len: m[0].length,
  };
}

// 가게 이름: 금액·날짜·카드·이름·누적 같은 칸을 빼고 남은 덩어리 중 가장 그럴듯한 것
function guessMerchant(msg, amt, when) {
  let s = msg;
  const cut = (at, len) => { s = s.slice(0, at) + '\n' + s.slice(at + len); };
  // 뒤쪽부터 지워야 앞쪽 위치가 안 바뀐다
  [amt, when].filter(Boolean).sort((a, b) => b.at - a.at).forEach((x) => cut(x.at, x.len));
  const pieces = s
    .replace(/누적[^\n]*|잔액[^\n]*|잔여[^\n]*/g, '\n')
    .split(/\n|\s{2,}/).map((x) => x.trim()).filter(Boolean)
    .map((x) => x.replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter((x) => x && !NOISE.test(x) && !/^[\d*,.:()\-/\s]+$/.test(x)
      && !new RegExp(`^(?:${CARDS.join('|')})`).test(x)
      && !/^[가-힣]\*[가-힣]?님?$/.test(x)); // 이름(홍*동)
  const last = pieces.length ? pieces[pieces.length - 1] : '';
  return last.replace(/^\((.*)\)$/, '$1').trim().slice(0, 40); // 출금 문자의 "(받는 곳)"

}

// 문자 한 통 → { ok, amount, currency, date, time, merchant, card, cancel, raw }
// ok=false면 금액을 못 찾은 것(결제 문자가 아닐 수 있음) — 화면에서 빼거나 '확인 필요'로 보여 준다
export function parseCardSms(msg, { year = new Date().getFullYear() } = {}) {
  const raw = String(msg || '').trim();
  const flat = raw.replace(/\[(?:Web|웹|국제)발신\]/gi, '').trim();
  const amt = parseAmount(flat);
  const when = parseWhen(flat, year);
  const card = (flat.match(new RegExp(`(${CARDS.join('|')})`)) || [])[1] || null;
  const cancel = /취소/.test(flat);
  const declined = /거절/.test(flat);
  const incoming = /입금|환급|캐시백/.test(flat) && !/출금|승인|사용/.test(flat); // 들어온 돈은 지출이 아니다
  if (!amt || !(amt.amount > 0) || declined || incoming) return { ok: false, raw, cancel, declined, incoming };
  const voucher = (flat.match(VOUCHER) || [])[1] || null;
  const kind = /출금/.test(flat) ? 'withdraw' : voucher ? 'voucher' : 'card';
  let merchant = guessMerchant(flat, amt, when);
  if (voucher && merchant === voucher) merchant = ''; // 상품권 문자엔 가게가 없다 — 화면에서 "○○상품권 결제"로
  if (kind === 'withdraw') merchant = ''; // 출금 문자의 (괄호)는 예금주·받는 사람 이름 — 가게가 아니고, 이름을 지출 제목에 남기지 않는다
  return {
    ok: true, raw, kind, card, voucher, cancel,
    amount: amt.amount, currency: amt.currency,
    date: when?.date || null, time: when?.time || null,
    merchant,
  };
}

// 붙여 넣은 글 전체 → 후보 목록. 취소 문자는 같은 금액·가게의 승인과 짝지어 둘 다 뺀다
export function parseCardSmsBatch(text, opts) {
  const all = splitMessages(text).map((m) => parseCardSms(m, opts));
  const items = all.filter((x) => x.ok && !x.cancel);
  for (const c of all.filter((x) => x.ok && x.cancel)) {
    const i = items.findIndex((x) => x.amount === c.amount && x.currency === c.currency && (!c.merchant || x.merchant === c.merchant));
    if (i >= 0) items.splice(i, 1);
  }
  return { items, skipped: all.filter((x) => !x.ok).length, canceled: all.filter((x) => x.ok && x.cancel).length };
}
