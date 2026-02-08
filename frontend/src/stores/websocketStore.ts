import { create } from 'zustand';
import { useMessagesStore } from './messagesStore';
import { useUsersStore } from './usersStore';

interface IncomingCall {
  from: number
  data: unknown
}

interface WebSocketState {
  socket: WebSocket | null
  isConnected: boolean
  incomingCall: IncomingCall | null
  connect: () => void
  disconnect: () => void
  sendTyping: (to: number, typing: boolean) => void
  sendCallOffer: (to: number, data: unknown) => void
  sendCallAnswer: (to: number, data: unknown) => void
  sendIceCandidate: (to: number, candidate: RTCIceCandidate) => void
  endCall: (to: number) => void
  clearIncomingCall: () => void
}

// Module-level tracking to prevent reconnect loops and stale socket interference
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _currentSocket: WebSocket | null = null; // the socket we intend to be active

export const useWebSocketStore = create<WebSocketState>((set, get) => ({
  socket: null,
  isConnected: false,
  incomingCall: null,

  connect: () => {
    const token = localStorage.getItem('token');
    if (!token) return;

    // Clear any pending reconnect
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    // Kill existing socket — remove its handlers so it can't interfere
    if (_currentSocket) {
      const old = _currentSocket;
      _currentSocket = null;
      old.onopen = null;
      old.onclose = null;
      old.onmessage = null;
      old.onerror = null;
      old.close();
    }

    // In dev, connect directly to backend. In prod, use same host
    const isDev = window.location.port === '5173'; // Vite default port
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = isDev ? 'localhost:8080' : window.location.host;
    const wsUrl = `${protocol}//${host}/api/ws?token=${encodeURIComponent(token)}`;
    
    console.log(`[WebSocket] Connecting to: ${wsUrl.replace(/token=[^&]+/, 'token=***')}`);
    
    const socket = new WebSocket(wsUrl);
    _currentSocket = socket;

    socket.onopen = () => {
      if (_currentSocket !== socket) return; // stale
      console.log('WebSocket connected');
      set({ isConnected: true, socket });
    };

    socket.onclose = (event) => {
      if (_currentSocket !== socket) return; // stale socket closing, ignore
      console.log(`[WebSocket] Disconnected - Code: ${event.code}, Reason: ${event.reason || 'none'}, Clean: ${event.wasClean}`);
      _currentSocket = null;
      set({ isConnected: false, socket: null });
      // Auto-reconnect
      _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        get().connect();
      }, 3000);
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    };

    set({ socket });
  },

  disconnect: () => {
    // Clear any pending reconnect
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    if (_currentSocket) {
      const old = _currentSocket;
      _currentSocket = null;
      old.onopen = null;
      old.onclose = null;
      old.onmessage = null;
      old.onerror = null;
      old.close();
    }
    set({ socket: null, isConnected: false });
  },

  sendTyping: (to: number, typing: boolean) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected) return;

    socket.send(JSON.stringify({
      type: 'typing',
      payload: { to, typing }
    }));
  },

  sendCallOffer: (to: number, data: unknown) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected) return;

    socket.send(JSON.stringify({
      type: 'call_offer',
      payload: { to, data }
    }));
  },

  sendCallAnswer: (to: number, data: unknown) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected) return;

    socket.send(JSON.stringify({
      type: 'call_answer',
      payload: { to, data }
    }));
  },

  sendIceCandidate: (to: number, candidate: RTCIceCandidate) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected) return;

    socket.send(JSON.stringify({
      type: 'call_ice',
      payload: { to, data: candidate.toJSON() }
    }));
  },

  endCall: (to: number) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected) return;

    socket.send(JSON.stringify({
      type: 'call_end',
      payload: { to }
    }));
  },

  clearIncomingCall: () => {
    set({ incomingCall: null });
  },
}));

// Helper to decode data field from Go backend (base64-encoded JSON)
function decodeMessageData(data: unknown): any {
  if (typeof data === 'string') {
    try {
      // Try base64 decode first (Go []byte fields are base64-encoded in JSON)
      return JSON.parse(atob(data));
    } catch {
      try {
        // Fall back to parsing as plain JSON
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
  } else if (data instanceof Uint8Array) {
    // Raw bytes - decode as UTF-8 then parse
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return null;
    }
  } else if (typeof data === 'object' && data !== null) {
    // Already an object
    return data;
  }
  return null;
}

function handleWebSocketMessage(message: any) {
  console.log('[WebSocket] Raw message:', message);
  switch (message.type) {
    case 'message':
      console.log('[WebSocket] Incoming message from user:', message.from, 'to:', message.to);
      // Get current user ID to properly set receiver_id
      const token = localStorage.getItem('token');
      const currentUserId = token ? JSON.parse(atob(token.split('.')[1])).user_id : 0;
      
      const msg = {
        id: Date.now(),
        sender_id: message.from,
        receiver_id: message.to || currentUserId,
        type: 'text' as const,
        content: message.content,
        nonce: message.nonce,
        timestamp: new Date(message.timestamp * 1000).toISOString(),
        read: false,
      };
      
      useMessagesStore.getState().addMessage(msg);
      
      // Dispatch event for notification system
      window.dispatchEvent(new CustomEvent('ws-message-received', {
        detail: msg
      }));
      break;

    case 'typing':
      const typingData = decodeMessageData(message.data);
      if (typingData) {
        useMessagesStore.getState().setTyping(message.from, typingData.typing);
      }
      break;

    case 'presence':
      const presenceData = decodeMessageData(message.data);
      console.log('[WebSocket] Presence update:', presenceData);
      if (presenceData && presenceData.user_id && typeof presenceData.online === 'boolean') {
        console.log('[WebSocket] Updating user', presenceData.user_id, 'to', presenceData.online ? 'ONLINE' : 'OFFLINE');
        useUsersStore.getState().updateUserStatus(presenceData.user_id, presenceData.online);
      } else {
        console.error('[WebSocket] Invalid presence data:', message.data);
      }
      break;

    case 'call_offer':
      const offerData = decodeMessageData(message.data);
      // Store incoming call in state for global handling
      useWebSocketStore.setState({ incomingCall: { from: message.from, data: offerData } });
      try {
        sessionStorage.setItem('ring.incomingOffer', JSON.stringify({
          from: message.from,
          data: offerData,
        }));
      } catch {
        // Ignore storage failures (private mode, quota, etc.)
      }
      window.dispatchEvent(new CustomEvent('incoming-call', {
        detail: { from: message.from, data: offerData }
      }));
      break;

    case 'call_answer':
      const answerData = decodeMessageData(message.data);
      window.dispatchEvent(new CustomEvent('call-answered', {
        detail: { data: answerData }
      }));
      break;

    case 'call_ice':
      const iceData = decodeMessageData(message.data);
      window.dispatchEvent(new CustomEvent('ice-candidate', {
        detail: { candidate: iceData }
      }));
      break;

    case 'call_end':
      // Clear incoming call state if the caller who was ringing us hung up
      {
        const currentIncoming = useWebSocketStore.getState().incomingCall;
        if (currentIncoming && currentIncoming.from === message.from) {
          useWebSocketStore.setState({ incomingCall: null });
        }
        try {
          const raw = sessionStorage.getItem('ring.incomingOffer');
          if (raw) {
            const parsed = JSON.parse(raw) as { from?: number };
            if (parsed?.from === message.from) {
              sessionStorage.removeItem('ring.incomingOffer');
            }
          }
        } catch {
          // Ignore storage errors
        }
      }
      window.dispatchEvent(new CustomEvent('call-ended', {
        detail: { from: message.from }
      }));
      break;

    case 'read_receipt':
      console.log('[WebSocket] Read receipt from user:', message.from);
      useMessagesStore.getState().markMessagesAsRead(message.from);
      break;

    case 'clear_messages':
      console.log('[WebSocket] Clear messages from user:', message.from);
      useMessagesStore.getState().clearMessagesLocal(message.from);
      break;
  }
}
