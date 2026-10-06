// 공유 — 로컬 모드 스냅샷 링크 / 카톡 붙여넣기용 텍스트 / 세로 이미지 카드 / 송금 링크

import { fromMinor } from './settle.js?v=202610070811';

// ───── 스냅샷 (로컬 모드 전용: 링크 안에 방 전체를 압축해 담는다) ─────
const b64url = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function encodeSnapshot(trip) {
  const json = new TextEncoder().encode(JSON.stringify(trip));
  if (typeof CompressionStream === 'function') {
    return 'z' + b64url.enc(await pipe(json, new CompressionStream('deflate-raw')));
  }
  return 'j' + b64url.enc(json);
}

export async function decodeSnapshot(s) {
  const bytes = b64url.dec(s.slice(1));
  const raw = s[0] === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  return JSON.parse(new TextDecoder().decode(raw));
}

// ───── 금액 표시 ─────
export function fmt(minor, cur) {
  const v = fromMinor(minor, cur);
  try {
    return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${v.toLocaleString('ko-KR')} ${cur}`;
  }
}

export function fmtMajor(major, cur) {
  try {
    return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(major);
  } catch {
    return `${Number(major).toLocaleString('ko-KR')} ${cur}`;
  }
}

// ───── 카톡 붙여넣기 텍스트 ─────
export function settlementText(trip, result, nameOf, link = '') {
  const cur = trip.baseCurrency;
  const lines = [`💸 ${trip.name} 정산`, ''];
  if (!result.pending.length) lines.push('보낼 돈이 없어요. 모두 정산 끝! 🎉');
  for (const t of result.pending) {
    lines.push(`${nameOf(t.from)} → ${nameOf(t.to)}  ${fmt(t.amount, cur)}`);
    const info = payLine(trip.participants.find((p) => p.id === t.to));
    if (info) lines.push(`   ${info}`);
  }
  const done = result.transfers.filter((t) => t.done);
  if (done.length) {
    lines.push('', '✓ 보낸 것');
    for (const t of done) lines.push(`${nameOf(t.from)} → ${nameOf(t.to)}  ${fmt(t.amount, cur)}`);
  }
  lines.push('', `총 지출 ${fmt(result.totalSpent, cur)} · 남은 송금 ${result.pending.length}번`, '트립N빵으로 계산했어요');
  if (link) lines.push(`송금 버튼·계산 근거: ${link}`);
  return lines.join('\n');
}

// 아직 안 보낸 사람에게 보낼 카톡 리마인드 (한 건 또는 여러 건)
export function reminderText(trip, transfers, nameOf, link) {
  const cur = trip.baseCurrency;
  const lines = [`🔔 '${trip.name}' 정산이 남았어요`, ''];
  for (const t of transfers) {
    lines.push(`${nameOf(t.from)} → ${nameOf(t.to)}  ${fmt(t.amount, cur)}`);
    const to = trip.participants.find((p) => p.id === t.to);
    const i = to?.payInfo || {};
    if (i.toss && cur === 'KRW') lines.push(`   토스로 보내기 https://toss.me/${i.toss}/${t.amount}`);
    else if (i.account) lines.push(`   계좌 ${i.account}`);
  }
  lines.push('', '보내고 나서 정산표에서 "보냈어요 ✓"를 눌러 주세요', link);
  return lines.join('\n');
}

function payLine(p) {
  const i = p?.payInfo || {};
  if (i.account) return `계좌 ${i.account}`;
  if (i.toss) return `토스 toss.me/${i.toss}`;
  return '';
}

// ───── 송금 링크 ─────
// 공식 송금 딥링크는 없다(2026-10 확인). 받는 사람이 등록한 정보로만 만든다.
//  - 토스아이디: https://toss.me/{id}/{금액}  (1회 30만·1일 100만 원 한도)
//  - 카카오페이 송금코드 링크: 받는 사람이 직접 붙여 넣은 qr.kakaopay.com 링크 그대로
//  - 계좌: 복사 버튼
export function transferLinks(receiver, amountMinor, cur) {
  const i = receiver?.payInfo || {};
  const out = [];
  if (i.toss && cur === 'KRW') {
    const id = encodeURIComponent(i.toss.replace(/^.*toss\.me\//, '').replace(/\/.*$/, ''));
    out.push({ kind: 'toss', label: '토스로 보내기', href: `https://toss.me/${id}/${amountMinor}`, over: amountMinor > 300000 });
  }
  if (i.kakao && /^https:\/\/qr\.kakaopay\.com\//.test(i.kakao)) {
    out.push({ kind: 'kakao', label: '카카오페이', href: i.kakao });
  }
  if (i.account) out.push({ kind: 'account', label: '계좌 복사', copy: i.account });
  return out;
}

// ───── 세로 이미지 카드 (카톡 공유용 PNG) ─────
export async function settlementImage(trip, result, nameOf) {
  const cur = trip.baseCurrency;
  const W = 720, pad = 48, rowH = 84;
  const rows = Math.max(1, result.transfers.length);
  const H = 260 + rows * rowH + 120;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, s) => `${w} ${s}px "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;

  g.fillStyle = '#FFF8EC'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#FF7A1A'; g.fillRect(0, 0, W, 12);
  g.fillStyle = '#1F1A14'; g.font = font(800, 44); g.fillText(trip.name, pad, 100);
  g.fillStyle = '#7A6A58'; g.font = font(500, 26);
  g.fillText(result.pending.length
    ? `총 지출 ${fmt(result.totalSpent, cur)} · 송금 ${result.pending.length}번이면 끝`
    : `총 지출 ${fmt(result.totalSpent, cur)} · 정산 완료`, pad, 148);

  let y = 220;
  if (!result.transfers.length) {
    g.fillStyle = '#1F1A14'; g.font = font(700, 32); g.fillText('보낼 돈이 없어요 🎉', pad, y + 20);
  }
  for (const t of result.transfers) {
    g.fillStyle = '#FFFFFF';
    roundRect(g, pad - 8, y - 46, W - 2 * pad + 16, rowH - 14, 18); g.fill();
    g.fillStyle = t.done ? '#A8977F' : '#1F1A14'; g.font = font(700, 30);
    g.fillText(`${t.done ? '✓ ' : ''}${nameOf(t.from)}  →  ${nameOf(t.to)}`, pad + 12, y);
    g.font = font(800, 32); g.fillStyle = t.done ? '#A8977F' : '#E2560B';
    const s = fmt(t.amount, cur);
    g.fillText(s, W - pad - 12 - g.measureText(s).width, y);
    y += rowH;
  }
  g.fillStyle = '#A8977F'; g.font = font(500, 22);
  g.fillText('트립N빵 — 링크 하나로 여행 정산', pad, H - 48);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
