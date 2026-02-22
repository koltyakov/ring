import { registerSW } from 'virtual:pwa-register';

type UpdateSWFn = (reloadPage?: boolean) => Promise<void>;

export const PWA_NEED_REFRESH_EVENT = 'pwa:need-refresh';
export const PWA_OFFLINE_READY_EVENT = 'pwa:offline-ready';

interface PwaNeedRefreshDetail {
  updateSW: UpdateSWFn
}

declare global {
  interface WindowEventMap {
    [PWA_NEED_REFRESH_EVENT]: CustomEvent<PwaNeedRefreshDetail>
    [PWA_OFFLINE_READY_EVENT]: Event
  }
}

export function registerPwaServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      window.dispatchEvent(new CustomEvent<PwaNeedRefreshDetail>(PWA_NEED_REFRESH_EVENT, {
        detail: { updateSW },
      }));
    },
    onOfflineReady() {
      window.dispatchEvent(new Event(PWA_OFFLINE_READY_EVENT));
    },
  });
}

