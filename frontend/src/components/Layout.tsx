import { useEffect, useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useUsersStore } from '../stores/usersStore';
import { useMessagesStore } from '../stores/messagesStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useWebSocketStore } from '../stores/websocketStore';

interface LayoutProps {
  children: React.ReactNode
}

interface IncomingCallData {
  from: number
  data: unknown
  callId?: string | null
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
  const isOnCallPage = location.pathname.startsWith('/call/');
  const processedMessagesRef = useRef<Set<string>>(new Set());

  // Load users first, then connect WebSocket so presence updates have targets
  useEffect(() => {
    fetchUsers().then(() => connect());

    return () => {
      disconnect();
    };
  }, [fetchUsers, connect, disconnect]);

  // Periodic refetch as a fallback to keep online status in sync
  useEffect(() => {
    if (!isConnected) return;
    
    const interval = setInterval(() => {
      fetchUsers();
    }, 30000);
    
    return () => clearInterval(interval);
  }, [isConnected, fetchUsers]);

  // Handle incoming calls globally — but not while already on a call page
  useEffect(() => {
    if (incomingCall && !isOnCallPage) {
      setPendingCall(incomingCall);
    }
  }, [incomingCall, isOnCallPage]);

  // Auto-dismiss modal immediately when navigating to call page
  useEffect(() => {
    if (isOnCallPage) {
      setPendingCall(null);
      clearIncomingCall();
    }
  }, [isOnCallPage, clearIncomingCall]);

  // Ringing timeout — auto-dismiss after 45 seconds if not answered
  useEffect(() => {
    if (!pendingCall) return;
    const timeout = setTimeout(() => {
      setPendingCall(null);
      clearIncomingCall();
    }, 45_000);
    return () => clearTimeout(timeout);
  }, [pendingCall, clearIncomingCall]);

  // Listen for call-ended to dismiss the incoming call dialog when the caller hangs up
  useEffect(() => {
    const handleCallEnded = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // Dismiss if the caller who is ringing us ended the call
      setPendingCall(prev => {
        if (prev && detail?.from === prev.from) {
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
  }, [clearIncomingCall]);

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
      const token = localStorage.getItem('token');
      const currentUserId = token ? JSON.parse(atob(token.split('.')[1])).user_id : 0;
      
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
      setPendingCall(null);
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
    setPendingCall(null);
  };

  const caller = pendingCall ? useUsersStore.getState().getUserById(pendingCall.from) : null;

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
      {pendingCall && caller && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-2xl p-8 max-w-sm w-full text-center">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-white font-bold text-2xl mx-auto mb-4">
              {caller.username[0].toUpperCase()}
            </div>
            <h2 className="text-xl font-bold text-white mb-2">{caller.username}</h2>
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
