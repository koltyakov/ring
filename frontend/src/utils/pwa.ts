import { registerSW } from 'virtual:pwa-register';

type UpdateSWFn = (reloadPage?: boolean) => Promise<void>;

export const PWA_NEED_REFRESH_EVENT = 'pwa:need-refresh';
export const PWA_OFFLINE_READY_EVENT = 'pwa:offline-ready';
let registeredUpdateSW: UpdateSWFn | null = null;

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
  registeredUpdateSW = updateSW;
}

export async function forcePwaUpgrade() {
  if (typeof window === 'undefined') return;

  if (!('serviceWorker' in navigator)) {
    window.location.reload();
    return;
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(async (registration) => {
      try {
        await registration.update();
      } catch {
        // Ignore update check failures and continue with fallback behavior.
      }
    }));
  } catch {
    // Ignore registration lookup failures.
  }

  if (registeredUpdateSW) {
    try {
      await registeredUpdateSW(true);
      return;
    } catch {
      // Fall through to a hard reload if no waiting worker is available.
    }
  }

  window.location.reload();
}
