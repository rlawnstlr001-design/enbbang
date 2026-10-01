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

export function haptic(kind = 'light') {
  if (!isApp) return;
  const p = kind === 'success' ? Haptics.notification({ type: 'SUCCESS' }) : Haptics.impact({ style: kind === 'medium' ? 'MEDIUM' : 'LIGHT' });
  p.catch(() => {});
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
