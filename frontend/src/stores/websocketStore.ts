import { create } from 'zustand';
import { useMessagesStore } from './messagesStore';
import { useUsersStore } from './usersStore';

interface IncomingCall {
  from: number
  data: unknown
  callId: string | null
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
  sendIceCandidate: (to: number, candidate: unknown) => void
  endCall: (to: number) => void
  clearIncomingCall: () => void
}

interface DecodedSignal {
  callId: string | null
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  raw: unknown
}

// Module-level tracking to prevent reconnect loops and stale socket interference
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let currentSocket: WebSocket | null = null;
let manualDisconnect = false;

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function wsPathFromBasePath(pathname: string): string {
  const basePath = trimTrailingSlash(pathname || '');
  if (!basePath || basePath === '/') return '/api/ws';
  if (basePath.endsWith('/api/ws')) return basePath;
  if (basePath.endsWith('/api')) return `${basePath}/ws`;
  return `${basePath}/api/ws`;
}

function buildWebSocketUrl(token: string): string {
  const envWsBase = (import.meta.env.VITE_WS_BASE_URL as string | undefined)?.trim();
  const envApiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();

  if (envWsBase) {
    const url = new URL(envWsBase);
    url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
    url.pathname = wsPathFromBasePath(url.pathname);
    url.search = '';
    url.hash = '';
    url.searchParams.set('token', token);
    return url.toString();
  }

  if (envApiBase) {
    const apiUrl = new URL(envApiBase);
    apiUrl.protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    apiUrl.pathname = wsPathFromBasePath(apiUrl.pathname);
    apiUrl.search = '';
    apiUrl.hash = '';
    apiUrl.searchParams.set('token', token);
    return apiUrl.toString();
  }

  const isDev = window.location.port === '5173';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = isDev ? 'localhost:8080' : window.location.host;
  const url = new URL(`${protocol}//${host}/api/ws`);
  url.searchParams.set('token', token);
  return url.toString();
}

function safeParseTokenUserId(): number {
  const token = localStorage.getItem('token');
  if (!token) return 0;

  try {
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const parsed = JSON.parse(atob(payload)) as { user_id?: number };
    return typeof parsed.user_id === 'number' ? parsed.user_id : 0;
  } catch {
    return 0;
  }
}

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeMessageData(data: unknown): unknown {
  if (typeof data === 'string') {
    // Go marshals []byte as base64 in JSON. Decode that first, then parse.
    try {
      const decoded = atob(data);
      const parsed = parseJsonString(decoded);
      if (parsed !== null) return parsed;
    } catch {
      // ignore
    }

    const direct = parseJsonString(data);
    return direct ?? data;
  }

  if (data instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return null;
    }
  }

  if (typeof data === 'object' && data !== null) {
    return data;
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseSignalPayload(data: unknown): DecodedSignal {
  const decoded = decodeMessageData(data);

  if (!isObject(decoded)) {
    return { callId: null, raw: decoded };
  }

  const callId = typeof decoded.callId === 'string' ? decoded.callId : null;
  const description = isObject(decoded.description)
    ? decoded.description as unknown as RTCSessionDescriptionInit
    : undefined;
  const candidate = isObject(decoded.candidate)
    ? decoded.candidate as unknown as RTCIceCandidateInit
    : undefined;

  if (description || candidate) {
    return { callId, description, candidate, raw: decoded };
  }

  // Backward compatibility with raw SDP or ICE payloads.
  if (typeof decoded.type === 'string' && typeof decoded.sdp === 'string') {
    return {
      callId,
      description: decoded as unknown as RTCSessionDescriptionInit,
      raw: decoded,
    };
  }

  if (typeof decoded.candidate === 'string' || typeof decoded.sdpMid === 'string' || typeof decoded.sdpMLineIndex === 'number') {
    return {
      callId,
      candidate: decoded as unknown as RTCIceCandidateInit,
      raw: decoded,
    };
  }

  return { callId, raw: decoded };
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function closeSocket(socket: WebSocket) {
  socket.onopen = null;
  socket.onclose = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.close();
}

function scheduleReconnect(connect: () => void) {
  clearReconnectTimer();

  const backoff = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
  const jitter = Math.floor(Math.random() * 250);
  const delay = backoff + jitter;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts += 1;
    connect();
  }, delay);
}

function dispatchWindowEvent<T>(name: string, detail: T) {
  window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

function handleWebSocketMessage(message: { id?: number; type?: string; from?: number; to?: number; data?: unknown; content?: string; nonce?: string; timestamp?: number }) {
  switch (message.type) {
    case 'message': {
      const currentUserId = safeParseTokenUserId();
      const timestampMs = typeof message.timestamp === 'number' ? message.timestamp * 1000 : Date.now();

      const msg = {
        id: typeof message.id === 'number' ? message.id : Date.now(),
        sender_id: message.from ?? 0,
        receiver_id: message.to ?? currentUserId,
        type: 'text' as const,
        content: message.content ?? '',
        nonce: message.nonce ?? '',
        timestamp: new Date(timestampMs).toISOString(),
        read: false,
      };

      useMessagesStore.getState().addMessage(msg);
      dispatchWindowEvent('ws-message-received', msg);
      break;
    }

    case 'typing': {
      const typingData = decodeMessageData(message.data);
      if (!isObject(typingData) || typeof typingData.typing !== 'boolean') return;
      useMessagesStore.getState().setTyping(message.from ?? 0, typingData.typing);
      break;
    }

    case 'presence': {
      const presenceData = decodeMessageData(message.data);
      if (!isObject(presenceData)) return;
      if (typeof presenceData.user_id !== 'number' || typeof presenceData.online !== 'boolean') return;
      useUsersStore.getState().updateUserStatus(presenceData.user_id, presenceData.online);
      break;
    }

    case 'call_offer': {
      const signal = parseSignalPayload(message.data);
      const from = message.from ?? 0;
      const offerData = signal.description ?? signal.raw;

      useWebSocketStore.setState({ incomingCall: { from, data: offerData, callId: signal.callId } });

      try {
        sessionStorage.setItem('ring.incomingOffer', JSON.stringify({
          from,
          data: offerData,
          callId: signal.callId,
        }));
      } catch {
        // Ignore storage failures.
      }

      dispatchWindowEvent('incoming-call', {
        from,
        data: offerData,
        callId: signal.callId,
      });
      break;
    }

    case 'call_answer': {
      const signal = parseSignalPayload(message.data);
      dispatchWindowEvent('call-answered', {
        from: message.from ?? 0,
        data: signal.description ?? signal.raw,
        callId: signal.callId,
      });
      break;
    }

    case 'call_ice': {
      const signal = parseSignalPayload(message.data);
      dispatchWindowEvent('ice-candidate', {
        from: message.from ?? 0,
        candidate: signal.candidate ?? signal.raw,
        callId: signal.callId,
      });
      break;
    }

    case 'call_end': {
      const from = message.from ?? 0;

      const currentIncoming = useWebSocketStore.getState().incomingCall;
      if (currentIncoming && currentIncoming.from === from) {
        useWebSocketStore.setState({ incomingCall: null });
      }

      try {
        const raw = sessionStorage.getItem('ring.incomingOffer');
        if (raw) {
          const parsed = JSON.parse(raw) as { from?: number };
          if (parsed.from === from) {
            sessionStorage.removeItem('ring.incomingOffer');
          }
        }
      } catch {
        // Ignore storage failures.
      }

      dispatchWindowEvent('call-ended', { from });
      break;
    }

    case 'read_receipt':
      useMessagesStore.getState().markMessagesAsRead(message.from ?? 0);
      break;

    case 'clear_messages':
      useMessagesStore.getState().clearMessagesLocal(message.from ?? 0);
      break;
  }
}

export const useWebSocketStore = create<WebSocketState>((set, get) => ({
  socket: null,
  isConnected: false,
  incomingCall: null,

  connect: () => {
    const token = localStorage.getItem('token');
    if (!token) return;

    manualDisconnect = false;
    clearReconnectTimer();

    // If we already have an active or connecting socket, avoid duplicate connects.
    if (currentSocket && (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (currentSocket) {
      closeSocket(currentSocket);
      currentSocket = null;
    }

    const wsUrl = buildWebSocketUrl(token);
    console.info('[WS] Connecting to', wsUrl.replace(/token=[^&]+/, 'token=<redacted>'));

    const socket = new WebSocket(wsUrl);
    currentSocket = socket;

    socket.onopen = () => {
      if (currentSocket !== socket) return;
      reconnectAttempts = 0;
      console.info('[WS] Connected');
      set({ isConnected: true, socket });
    };

    socket.onclose = (event) => {
      if (currentSocket !== socket) return;

      console.warn('[WS] Closed', { code: event.code, reason: event.reason, wasClean: event.wasClean });
      currentSocket = null;
      set({ isConnected: false, socket: null });

      if (manualDisconnect) return;
      if (!localStorage.getItem('token')) return;

      scheduleReconnect(get().connect);
    };

    socket.onerror = (event) => {
      console.warn('[WS] Error during handshake/connection', event);
      // Rely on onclose to transition to disconnected/reconnect.
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as {
          id?: number
          type?: string
          from?: number
          to?: number
          data?: unknown
          content?: string
          nonce?: string
          timestamp?: number
        };
        handleWebSocketMessage(message);
      } catch {
        // Ignore malformed messages.
      }
    };

    set({ socket });
  },

  disconnect: () => {
    manualDisconnect = true;
    clearReconnectTimer();

    if (currentSocket) {
      closeSocket(currentSocket);
      currentSocket = null;
    }

    set({ socket: null, isConnected: false, incomingCall: null });
  },

  sendTyping: (to: number, typing: boolean) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({
      type: 'typing',
      payload: { to, typing },
    }));
  },

  sendCallOffer: (to: number, data: unknown) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({
      type: 'call_offer',
      payload: { to, data },
    }));
  },

  sendCallAnswer: (to: number, data: unknown) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({
      type: 'call_answer',
      payload: { to, data },
    }));
  },

  sendIceCandidate: (to: number, candidate: unknown) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({
      type: 'call_ice',
      payload: { to, data: candidate },
    }));
  },

  endCall: (to: number) => {
    const { socket, isConnected } = get();
    if (!socket || !isConnected || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({
      type: 'call_end',
      payload: { to },
    }));
  },

  clearIncomingCall: () => {
    set({ incomingCall: null });
  },
}));
