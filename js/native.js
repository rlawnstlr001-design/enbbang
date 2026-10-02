// 앱(Capacitor) 안에서만 쓰는 기능. 웹에서는 isApp=false라 모두 조용히 건너뛴다.
// 번들러가 없으므로 www 빌드 때 넣는 js/capacitor.js(코어)가 만든 window.Capacitor를 쓴다.

const C = window.Capacitor;
export const isApp = !!C?.isNativePlatform?.();
export const platform = isApp ? C.getPlatform() : 'web';
export const SITE = 'https://tripnbbang.com/'; // 앱 안 주소는 localhost라, 공유 링크는 항상 실제 도메인으로

const plug = (name) => (isApp ? C.registerPlugin(name) : null);
const Share = plug('Share');
const Haptics = plug('Haptics');
const Notifs = plug('LocalNotifications');
const App = plug('App');
const Files = plug('Filesystem');
const StatusBar = plug('StatusBar');

export async function nativeShare({ title, text, url }) {
  if (!isApp) return false;
  try { await Share.share({ title, text, url, dialogTitle: '친구에게 보내기' }); } catch { /* 사용자가 닫음 */ }
  return true;
}

// 정산 이미지 공유: 캐시 폴더에 PNG로 쓴 뒤 공유 시트로 넘긴다
export async function nativeShareImage(blob, filename, title) {
  if (!isApp) return false;
  const data = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.readAsDataURL(blob);
  });
  const { uri } = await Files.writeFile({ path: filename.replace(/[^\w.-]/g, '_'), data, directory: 'CACHE' });
  try { await Share.share({ title, files: [uri], dialogTitle: '정산표 보내기' }); } catch { /* 닫음 */ }
  return true;
}

// ───── 설정 (이 기기에만 저장) ─────
const SETTINGS_KEY = 'enbbang:settings';
const DEFAULTS = { vibration: 'long', sound: true, theme: 'system', alarmHour: 10 };

export function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
export function setSetting(key, value) {
  const s = getSettings();
  s[key] = value;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* 저장 불가 */ }
  if (key === 'theme') applyTheme();
}
export function applyTheme() {
  const t = getSettings().theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ───── 진동 ─────
// kind: 'tap'(가벼운 누름) | 'add'(저장) | 'paid'(송금 완료) | 'done'(정산 끝)
// 안드로이드는 길이(ms)로 "위이잉"을 낸다. iOS는 길이 조절이 안 돼 햅틱 종류로 구분.
const VIBE_MS = {
  short: { tap: 25, add: 70, paid: 90, done: 140 },
  long: { tap: 45, add: 260, paid: 320, done: 520 },
};
export function haptic(kind = 'tap') {
  const level = getSettings().vibration;
  if (level === 'off') return;
  const ms = (VIBE_MS[level] || VIBE_MS.long)[kind] ?? 60;
  if (isApp && platform === 'ios') {
    const p = kind === 'tap' ? Haptics.impact({ style: level === 'long' ? 'MEDIUM' : 'LIGHT' }) : Haptics.notification({ type: 'SUCCESS' });
    p.catch(() => {});
  } else if (isApp) {
    Haptics.vibrate({ duration: ms }).catch(() => {});
  } else {
    try { navigator.vibrate?.(ms); } catch { /* 지원 안 함 */ }
  }
}

// ───── 효과음 (파일 없이 Web Audio로 합성) ─────
let audio;
const TONES = {
  tap: [[700, 0.04]],
  add: [[880, 0.07], [1320, 0.12]],
  paid: [[660, 0.07], [990, 0.07], [1320, 0.14]],
  done: [[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.24]],
};
export function sound(kind = 'tap') {
  if (!getSettings().sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    let t = audio.currentTime;
    for (const [freq, dur] of TONES[kind] || TONES.tap) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === 'tap' ? 0.05 : 0.16, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
      t += dur * 0.9;
    }
  } catch { /* 소리 재생 불가 환경 */ }
}

// 진동 + 효과음을 한 번에
export function feedback(kind) {
  haptic(kind);
  sound(kind);
}

// 정산 리마인드 로컬 알림. 같은 방·같은 송금은 같은 id라 다시 예약하면 덮어쓴다.
export async function scheduleReminder({ key, title, body, at, hash }) {
  if (!isApp) return 'unsupported';
  let perm = await Notifs.checkPermissions();
  if (perm.display !== 'granted') perm = await Notifs.requestPermissions();
  if (perm.display !== 'granted') return 'denied';
  const id = Math.abs([...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 2147483647;
  await Notifs.schedule({ notifications: [{ id, title, body, schedule: { at, allowWhileIdle: true }, extra: { hash } }] });
  return 'scheduled';
}

// 앱 열기 관련: 딥링크(tripnbbang.com 링크로 앱이 열림), 알림 탭, 안드로이드 뒤로가기
export function initNative({ onOpenHash, onBack }) {
  if (!isApp) return;
  document.documentElement.classList.add('is-app', `is-${platform}`);
  StatusBar.setStyle({ style: 'LIGHT' }).catch(() => {});
  if (platform === 'android') StatusBar.setBackgroundColor({ color: '#FFF8EC' }).catch(() => {});

  const openUrl = (url) => {
    try {
      const u = new URL(url);
      onOpenHash(u.hash || '#/');
    } catch { /* 무시 */ }
  };
  App.addListener('appUrlOpen', ({ url }) => openUrl(url));
  App.getLaunchUrl().then((r) => r?.url && openUrl(r.url)).catch(() => {});
  Notifs.addListener('localNotificationActionPerformed', ({ notification }) => {
    if (notification?.extra?.hash) onOpenHash(notification.extra.hash);
  });
  App.addListener('backButton', () => { if (!onBack()) App.exitApp(); });
}
