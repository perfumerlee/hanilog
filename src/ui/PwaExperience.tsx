import { useEffect, useState } from 'react';

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> };

export function PwaExperience() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const install = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    const installedEvent = () => { setInstalled(true); setInstallPrompt(null); setNotice('홈 화면 앱 설치가 완료됐습니다.'); };
    window.addEventListener('beforeinstallprompt', install);
    window.addEventListener('appinstalled', installedEvent);
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.getRegistration().then((registration) => {
        if (!registration) return;
        if (registration.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) setUpdateReady(true);
          });
        });
      });
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', install);
      window.removeEventListener('appinstalled', installedEvent);
    };
  }, []);

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setNotice(choice.outcome === 'accepted' ? '설치 요청을 확인했습니다.' : '설치를 취소했습니다. 브라우저 메뉴에서 나중에 설치할 수 있습니다.');
    setInstallPrompt(null);
  }
  async function applyUpdate() {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (!registration?.waiting) { setUpdateReady(false); setNotice('적용할 업데이트를 찾지 못했습니다.'); return; }
    const worker = registration.waiting;
    worker.postMessage({ type: 'SKIP_WAITING' });
    worker.addEventListener('statechange', () => { if (worker.state === 'activated') window.location.reload(); });
  }
  const isIos = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  const isStandalone = typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  if (!installPrompt && !isIos && !isAndroid && !updateReady && !notice && !installed) return null;
  return <aside className="pwa-notice" aria-live="polite">
    {updateReady ? <><span>새 버전의 HaniLog를 사용할 수 있습니다.</span><button type="button" className="secondary-action" onClick={() => void applyUpdate()}>업데이트 적용</button></> : null}
    {installPrompt && !isStandalone ? <><span>홈 화면에 추가하면 앱처럼 사용할 수 있습니다.</span><button type="button" className="secondary-action" onClick={() => void installApp()}>앱 설치</button></> : null}
    {isAndroid && !isStandalone && !installPrompt ? <span>브라우저 메뉴에서 “앱 설치” 또는 “홈 화면에 추가”를 찾아보세요. 메뉴가 없으면 현재 브라우저에서 설치를 지원하지 않을 수 있습니다.</span> : null}
    {isIos && !isStandalone ? <span>설치 안내: 공유 메뉴에서 “홈 화면에 추가”를 선택하세요. 설치 및 Push 지원 여부는 iOS 버전과 브라우저에 따라 다릅니다.</span> : null}
    {notice && <span>{notice}</span>}
    {installed && <span>설치 상태가 확인됐습니다.</span>}
  </aside>;
}
