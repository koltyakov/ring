import { useCallback, useEffect, useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useUsersStore } from '../stores/usersStore';
import { useMessagesStore } from '../stores/messagesStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useWebSocketStore } from '../stores/websocketStore';
import { PWA_NEED_REFRESH_EVENT, PWA_OFFLINE_READY_EVENT } from '../utils/pwa';

let incomingCallAudioCtx: AudioContext | null = null;

function getIncomingCallAudioCtx() {
  if (!incomingCallAudioCtx || incomingCallAudioCtx.state === 'closed') {
    incomingCallAudioCtx = new AudioContext();
  }
  if (incomingCallAudioCtx.state === 'suspended') {
    void incomingCallAudioCtx.resume();
  }
  return incomingCallAudioCtx;
}

function playIncomingCallTone(): () => void {
  try {
    const ctx = getIncomingCallAudioCtx();
    const gain = ctx.createGain();
    gain.gain.value = 0.08;
    gain.connect(ctx.destination);

    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const activeOscs = new Set<OscillatorNode>();

    const pulse = (frequency: number, startAt: number, duration: number) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.connect(gain);
      activeOscs.add(osc);
      osc.onended = () => activeOscs.delete(osc);
      osc.start(startAt);
      osc.stop(startAt + duration);
    };

    const ring = () => {
      if (stopped) return;
      const t = ctx.currentTime;

      pulse(660, t, 0.2);
      pulse(880, t, 0.2);
      pulse(660, t + 0.35, 0.2);
      pulse(880, t + 0.35, 0.2);

      timeout = setTimeout(ring, 3000);
    };

    ring();

    return () => {
      stopped = true;
      if (timeout) clearTimeout(timeout);
      for (const osc of activeOscs) {
        try {
          osc.stop();
        } catch {
          // already stopped
        }
      }
      activeOscs.clear();
    };
  } catch {
    return () => {
      // ignore audio init failures (e.g. autoplay restrictions)
    };
  }
}

interface LayoutProps {
  children: React.ReactNode
}

interface IncomingCallData {
  from: number
  data: unknown
  callId?: string | null
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function getCurrentUserId() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return 0;
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const parsed = JSON.parse(atob(payload)) as { user_id?: number };
    return typeof parsed.user_id === 'number' ? parsed.user_id : 0;
  } catch {
    return 0;
  }
}

export default function Layout({ children }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const fetchUsers = useUsersStore(state => state.fetchUsers);
  const connect = useWebSocketStore(state => state.connect);
  const disconnect = useWebSocketStore(state => state.disconnect);
  const isConnected = useWebSocketStore(state => state.isConnected);
  const incomingCall = useWebSocketStore(state => state.incomingCall);
  const clearIncomingCall = useWebSocketStore(state => state.clearIncomingCall);
  const wsEndCall = useWebSocketStore(state => state.endCall);
  const activeChatUserId = useMessagesStore(state => state.activeChatUserId);
  const notifications = useNotificationStore(state => state.notifications);
  const dismissNotification = useNotificationStore(state => state.dismissNotification);
  const showNotification = useNotificationStore(state => state.showNotification);
  
  const [pendingCall, setPendingCall] = useState<IncomingCallData | null>(null);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isPwaInstalled, setIsPwaInstalled] = useState(() =>
    window.matchMedia('(display-mode: standalone)').matches
  );
  const [isOfflineReady, setIsOfflineReady] = useState(false);
  const [isUpdateReady, setIsUpdateReady] = useState(false);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const pwaUpdateRef = useRef<null | ((reloadPage?: boolean) => Promise<void>)>(null);
  const isOnCallPage = location.pathname.startsWith('/call/');
  const processedMessagesRef = useRef<Set<string>>(new Set());
  const stopIncomingCallToneRef = useRef<(() => void) | null>(null);

  const stopIncomingCallTone = useCallback(() => {
    stopIncomingCallToneRef.current?.();
    stopIncomingCallToneRef.current = null;
  }, []);

  // Load users first, then connect WebSocket so presence updates have targets
  useEffect(() => {
    void fetchUsers().finally(() => {
      connect();
    });

    return () => {
      disconnect();
    };
  }, [fetchUsers, connect, disconnect]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      void fetchUsers();
      connect();
    };
    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [connect, fetchUsers]);

  // Periodic refetch as a fallback to keep online status in sync
  useEffect(() => {
    if (!isConnected) return;
    
    const interval = setInterval(() => {
      fetchUsers();
    }, 30000);
    
    return () => clearInterval(interval);
  }, [isConnected, fetchUsers]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      const installEvent = event as BeforeInstallPromptEvent;
      installEvent.preventDefault();
      setInstallPromptEvent(installEvent);
    };

    const handleAppInstalled = () => {
      setIsPwaInstalled(true);
      setInstallPromptEvent(null);
    };

    const handleOfflineReady = () => {
      setIsOfflineReady(true);
    };

    const handleNeedRefresh = (event: WindowEventMap[typeof PWA_NEED_REFRESH_EVENT]) => {
      pwaUpdateRef.current = event.detail.updateSW;
      setIsUpdateReady(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    window.addEventListener(PWA_OFFLINE_READY_EVENT, handleOfflineReady);
    window.addEventListener(PWA_NEED_REFRESH_EVENT, handleNeedRefresh);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      window.removeEventListener(PWA_OFFLINE_READY_EVENT, handleOfflineReady);
      window.removeEventListener(PWA_NEED_REFRESH_EVENT, handleNeedRefresh);
    };
  }, []);

  // Handle incoming calls globally — but not while already on a call page
  useEffect(() => {
    if (incomingCall && !isOnCallPage) {
      setPendingCall(incomingCall);
    }
  }, [incomingCall, isOnCallPage]);

  // Auto-dismiss modal immediately when navigating to call page
  useEffect(() => {
    if (isOnCallPage) {
      stopIncomingCallTone();
      setPendingCall(null);
      clearIncomingCall();
    }
  }, [isOnCallPage, clearIncomingCall, stopIncomingCallTone]);

  // Ringing timeout — auto-dismiss after 45 seconds if not answered
  useEffect(() => {
    if (!pendingCall) return;
    const timeout = setTimeout(() => {
      stopIncomingCallTone();
      setPendingCall(null);
      clearIncomingCall();
    }, 45_000);
    return () => clearTimeout(timeout);
  }, [pendingCall, clearIncomingCall, stopIncomingCallTone]);

  useEffect(() => {
    if (!pendingCall) {
      stopIncomingCallTone();
      return;
    }

    if (!stopIncomingCallToneRef.current) {
      stopIncomingCallToneRef.current = playIncomingCallTone();
    }

    return () => {
      // Keep the tone running across rerenders while the same modal remains open.
    };
  }, [pendingCall, stopIncomingCallTone]);

  useEffect(() => {
    return () => {
      stopIncomingCallTone();
    };
  }, [stopIncomingCallTone]);

  // Listen for call-ended to dismiss the incoming call dialog when the caller hangs up
  useEffect(() => {
    const handleCallEnded = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // Dismiss if the caller who is ringing us ended the call
      setPendingCall(prev => {
        if (prev && detail?.from === prev.from) {
          stopIncomingCallTone();
          clearIncomingCall();
          return null;
        }
        return prev;
      });
    };

    window.addEventListener('call-ended', handleCallEnded);
    return () => {
      window.removeEventListener('call-ended', handleCallEnded);
    };
  }, [clearIncomingCall, stopIncomingCallTone]);

  // Listen for incoming call events (backup mechanism) — skip if already on call page
  useEffect(() => {
    const handleIncomingCall = (e: CustomEvent) => {
      if (location.pathname.startsWith('/call/')) return;
      const { from, data, callId } = e.detail as { from: number; data: unknown; callId?: string | null };
      setPendingCall({ from, data, callId });
    };

    window.addEventListener('incoming-call', handleIncomingCall as EventListener);
    return () => {
      window.removeEventListener('incoming-call', handleIncomingCall as EventListener);
    };
  }, [location.pathname]);

  // Listen for new messages and show notifications
  useEffect(() => {
    const handleNewMessage = (e: CustomEvent) => {
      const message = e.detail;
      const currentUserId = getCurrentUserId();
      
      // Only show notification for incoming messages (not sent by us)
      if (message.sender_id === currentUserId) return;
      
      // Don't show notification if we're in the chat with this user
      if (activeChatUserId === message.sender_id) return;
      
      // Create a unique key for this message to prevent duplicates
      const messageKey = `${message.sender_id}-${message.timestamp}-${message.content}`;
      if (processedMessagesRef.current.has(messageKey)) return;
      processedMessagesRef.current.add(messageKey);
      
      // Clean up old processed messages (keep last 100)
      if (processedMessagesRef.current.size > 100) {
        const iterator = processedMessagesRef.current.values();
        for (let i = 0; i < 20; i++) {
          const value = iterator.next().value;
          if (value) processedMessagesRef.current.delete(value);
        }
      }
      
      const sender = useUsersStore.getState().getUserById(message.sender_id);
      if (!sender) return;
      
      showNotification({
        senderId: message.sender_id,
        senderName: sender.username,
        message: message.content ? 'New message' : 'Sent you a message',
      });
    };

    window.addEventListener('ws-message-received', handleNewMessage as EventListener);
    return () => {
      window.removeEventListener('ws-message-received', handleNewMessage as EventListener);
    };
  }, [activeChatUserId, showNotification]);

  const handleAcceptCall = () => {
    if (pendingCall) {
      clearIncomingCall();
      try {
        sessionStorage.removeItem('ring.incomingOffer');
      } catch {
        // Ignore storage errors
      }
      navigate(`/call/${pendingCall.from}?incoming=true`, {
        state: { incomingOffer: pendingCall },
      });
      stopIncomingCallTone();
      setPendingCall(null);
    }
  };

  const handleInstallPwa = async () => {
    if (!installPromptEvent) return;
    try {
      await installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice;
      if (choice.outcome === 'accepted') {
        setInstallPromptEvent(null);
      }
    } catch {
      // ignore prompt failures
    }
  };

  const handleApplyPwaUpdate = async () => {
    if (!pwaUpdateRef.current || isApplyingUpdate) return;
    setIsApplyingUpdate(true);
    try {
      await pwaUpdateRef.current(true);
    } finally {
      setIsApplyingUpdate(false);
    }
  };

  const handleDeclineCall = () => {
    if (pendingCall) {
      wsEndCall(pendingCall.from); // Notify the caller we declined
    }
    try {
      sessionStorage.removeItem('ring.incomingOffer');
    } catch {
      // Ignore storage errors
    }
    clearIncomingCall();
    stopIncomingCallTone();
    setPendingCall(null);
  };

  const caller = pendingCall ? useUsersStore.getState().getUserById(pendingCall.from) : null;
  const showInstallPrompt = Boolean(installPromptEvent) && !isPwaInstalled;

  return (
    <div className="h-full flex flex-col bg-slate-950 relative">
      {/* Notification animation styles */}
      <style>{`
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
      
      {children}

      {!isOnline && (
        <div className={`fixed left-4 right-4 z-40 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 backdrop-blur-sm ${showInstallPrompt || isOfflineReady || isUpdateReady ? 'bottom-28' : 'bottom-4'}`}>
          You are offline. Messages and calls will resume when the connection returns.
        </div>
      )}

      {(showInstallPrompt || isOfflineReady || isUpdateReady) && (
        <div className="fixed bottom-4 left-4 right-4 z-40 flex flex-col gap-2">
          {showInstallPrompt && (
            <div className="rounded-xl border border-slate-700 bg-slate-900/95 px-4 py-3 backdrop-blur-sm flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-white">Install ChatApp</p>
                <p className="text-xs text-slate-400">Open it like a native app and keep chat faster to launch.</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setInstallPromptEvent(null)}
                  className="px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800"
                >
                  Later
                </button>
                <button
                  onClick={() => void handleInstallPwa()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-600 text-white hover:bg-primary-500"
                >
                  Install
                </button>
              </div>
            </div>
          )}

          {isOfflineReady && !isUpdateReady && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 backdrop-blur-sm flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-white">Offline mode ready</p>
                <p className="text-xs text-slate-300">The app shell is cached for faster startup.</p>
              </div>
              <button
                onClick={() => setIsOfflineReady(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-slate-200 hover:bg-white/5"
              >
                Dismiss
              </button>
            </div>
          )}

          {isUpdateReady && (
            <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 backdrop-blur-sm flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-white">Update available</p>
                <p className="text-xs text-slate-300">Reload to apply the latest chat and call fixes.</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setIsUpdateReady(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-slate-200 hover:bg-white/5"
                >
                  Later
                </button>
                <button
                  onClick={() => void handleApplyPwaUpdate()}
                  disabled={isApplyingUpdate}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500 text-white hover:bg-blue-400 disabled:opacity-60"
                >
                  {isApplyingUpdate ? 'Updating...' : 'Reload'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* Message Notifications */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none">
        {notifications.map((notification) => (
          <button
            key={notification.id}
            onClick={() => {
              dismissNotification(notification.id);
              navigate(`/chat/${notification.senderId}`);
            }}
            className="pointer-events-auto bg-slate-800/95 backdrop-blur-sm border border-slate-700 rounded-xl px-4 py-3 shadow-lg shadow-black/20 flex items-center gap-3 min-w-[280px] max-w-[90vw] hover:bg-slate-700/95 transition-all duration-200"
            style={{
              animation: 'slideDown 0.3s ease-out',
            }}
          >
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-white font-semibold flex-shrink-0">
              {notification.senderName[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="font-medium text-white text-sm">{notification.senderName}</p>
              <p className="text-slate-400 text-xs truncate">{notification.message}</p>
            </div>
            <div className="w-2 h-2 rounded-full bg-primary-500 flex-shrink-0" />
          </button>
        ))}
      </div>
      
      {/* Incoming Call Modal */}
      {pendingCall && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-2xl p-8 max-w-sm w-full text-center">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-white font-bold text-2xl mx-auto mb-4">
              {(caller?.username?.[0] ?? `#${pendingCall.from}`[0] ?? '?').toUpperCase()}
            </div>
            <h2 className="text-xl font-bold text-white mb-2">{caller?.username ?? `User #${pendingCall.from}`}</h2>
            <p className="text-slate-400 mb-6">Incoming call...</p>
            
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={handleDeclineCall}
                className="w-14 h-14 rounded-full bg-red-500 text-white flex items-center justify-center"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <button
                onClick={handleAcceptCall}
                className="w-14 h-14 rounded-full bg-green-500 text-white flex items-center justify-center"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
