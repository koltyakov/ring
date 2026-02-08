import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useUsersStore } from '../stores/usersStore';
import { useWebSocketStore } from '../stores/websocketStore';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 30, max: 60 },
  facingMode: 'user',
};

type CallState = 'connecting' | 'ringing' | 'connected' | 'ended';

interface IncomingCallState {
  from: number
  data: unknown
  callId?: string | null
}

interface SignalEnvelope {
  callId: string
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

interface CallAnsweredDetail {
  from: number
  data: unknown
  callId?: string | null
}

interface IceCandidateDetail {
  from: number
  candidate: unknown
  callId?: string | null
}

interface IncomingCallDetail {
  from: number
  data: unknown
  callId?: string | null
}

let audioCtx: AudioContext | null = null;

function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

function playCallingTone(): () => void {
  const ctx = getAudioCtx();
  const gain = ctx.createGain();
  gain.gain.value = 0.08;
  gain.connect(ctx.destination);

  let stopped = false;
  let currentOscs: OscillatorNode[] = [];
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const ring = () => {
    if (stopped) return;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.value = 440;
    osc2.frequency.value = 480;
    osc1.connect(gain);
    osc2.connect(gain);
    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 2);
    osc2.stop(ctx.currentTime + 2);

    currentOscs = [osc1, osc2];
    timeout = setTimeout(ring, 4000);
  };

  ring();

  return () => {
    stopped = true;
    if (timeout) clearTimeout(timeout);
    currentOscs.forEach((osc) => {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
    });
    currentOscs = [];
  };
}

function playEndTone() {
  try {
    const ctx = getAudioCtx();
    const gain = ctx.createGain();
    gain.gain.value = 0.1;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 350;
    osc.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    // ignore
  }
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

function createCallId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeSignalData(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    // continue
  }

  try {
    return JSON.parse(atob(value));
  } catch {
    return value;
  }
}

function parseSignalData(value: unknown): {
  callId: string | null
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
} {
  const decoded = decodeSignalData(value);
  if (!isRecord(decoded)) {
    return { callId: null };
  }

  const callId = typeof decoded.callId === 'string' ? decoded.callId : null;

  if (isRecord(decoded.description)) {
    return {
      callId,
      description: decoded.description as unknown as RTCSessionDescriptionInit,
    };
  }

  if (isRecord(decoded.candidate)) {
    return {
      callId,
      candidate: decoded.candidate as unknown as RTCIceCandidateInit,
    };
  }

  if (typeof decoded.type === 'string' && typeof decoded.sdp === 'string') {
    return {
      callId,
      description: decoded as unknown as RTCSessionDescriptionInit,
    };
  }

  if (typeof decoded.candidate === 'string' || typeof decoded.sdpMid === 'string' || typeof decoded.sdpMLineIndex === 'number') {
    return {
      callId,
      candidate: decoded as unknown as RTCIceCandidateInit,
    };
  }

  return { callId: null };
}

export default function CallPage() {
  const { userId } = useParams<{ userId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const otherUserId = Number.parseInt(userId ?? '', 10);
  const isIncoming = new URLSearchParams(location.search).get('incoming') === 'true';

  const user = useUsersStore((state) => state.getUserById(otherUserId));
  const sendOffer = useWebSocketStore((state) => state.sendCallOffer);
  const sendAnswer = useWebSocketStore((state) => state.sendCallAnswer);
  const sendIceCandidate = useWebSocketStore((state) => state.sendIceCandidate);
  const endCall = useWebSocketStore((state) => state.endCall);
  const clearIncomingCall = useWebSocketStore((state) => state.clearIncomingCall);
  const isConnected = useWebSocketStore((state) => state.isConnected);

  const [callState, setCallState] = useState<CallState>('connecting');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isRemotePortrait, setIsRemotePortrait] = useState(false);
  const [callDuration, setCallDuration] = useState(0);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionFailTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectGraceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offerRetryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopAudioRef = useRef<(() => void) | null>(null);

  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const iceRestartingRef = useRef(false);
  const politeRef = useRef(false);
  const cleanedUpRef = useRef(false);
  const remoteDescriptionSetRef = useRef(false);
  const iceCandidateBufferRef = useRef<RTCIceCandidateInit[]>([]);
  const isMutedRef = useRef(false);
  const isVideoEnabledRef = useRef(false);
  const callIdRef = useRef<string | null>(null);
  const wasConnectedRef = useRef(false);

  const incomingOffer = (location.state as { incomingOffer?: IncomingCallState } | null)?.incomingOffer;
  const displayName = user?.username ?? 'User';
  const displayInitial = displayName[0]?.toUpperCase() ?? '?';

  const stopCallAudio = useCallback(() => {
    stopAudioRef.current?.();
    stopAudioRef.current = null;
  }, []);

  const clearRingingTimeout = useCallback(() => {
    if (!ringingTimeoutRef.current) return;
    clearTimeout(ringingTimeoutRef.current);
    ringingTimeoutRef.current = null;
  }, []);

  const clearCallFailTimeout = useCallback(() => {
    if (!connectionFailTimeoutRef.current) return;
    clearTimeout(connectionFailTimeoutRef.current);
    connectionFailTimeoutRef.current = null;
  }, []);

  const clearDisconnectGraceTimeout = useCallback(() => {
    if (!disconnectGraceTimeoutRef.current) return;
    clearTimeout(disconnectGraceTimeoutRef.current);
    disconnectGraceTimeoutRef.current = null;
  }, []);

  const clearOfferRetryInterval = useCallback(() => {
    if (!offerRetryIntervalRef.current) return;
    clearInterval(offerRetryIntervalRef.current);
    offerRetryIntervalRef.current = null;
  }, []);

  const ensureCallId = useCallback((preferred?: string | null): string => {
    if (callIdRef.current) return callIdRef.current;
    callIdRef.current = preferred && preferred.length > 0 ? preferred : createCallId();
    return callIdRef.current;
  }, []);

  const buildSignalEnvelope = useCallback((payload: Omit<SignalEnvelope, 'callId'>): SignalEnvelope => {
    return {
      callId: ensureCallId(),
      ...payload,
    };
  }, [ensureCallId]);

  const flushIceCandidates = useCallback(async () => {
    const pc = peerConnectionRef.current;
    if (!pc || !remoteDescriptionSetRef.current) return;

    const buffered = iceCandidateBufferRef.current.splice(0);
    for (const candidate of buffered) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn('[Call] Failed to add buffered ICE candidate:', error);
      }
    }
  }, []);

  const handleRemoteDescription = useCallback(async (desc: RTCSessionDescriptionInit) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;

    if (desc.type === 'answer' && pc.signalingState !== 'have-local-offer') {
      return;
    }

    await pc.setRemoteDescription(new RTCSessionDescription(desc));
    remoteDescriptionSetRef.current = true;
    await flushIceCandidates();
  }, [flushIceCandidates]);

  const handleRemoteOffer = useCallback(async (desc: RTCSessionDescriptionInit, remoteCallId?: string | null) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;

    const currentCallId = callIdRef.current;
    if (currentCallId && remoteCallId && currentCallId !== remoteCallId) {
      // Peer restarted signaling (e.g. page reload). Switch to the new call identity.
      callIdRef.current = remoteCallId;
      remoteDescriptionSetRef.current = false;
      iceCandidateBufferRef.current = [];
    }
    clearOfferRetryInterval();

    ensureCallId(remoteCallId);

    const offer = new RTCSessionDescription(desc);
    const offerCollision = offer.type === 'offer' && (makingOfferRef.current || pc.signalingState !== 'stable');
    ignoreOfferRef.current = !politeRef.current && offerCollision;

    if (ignoreOfferRef.current) {
      return;
    }

    if (offerCollision && politeRef.current && pc.signalingState !== 'stable') {
      try {
        await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
      } catch {
        // Rollback can fail in some browsers.
      }
    }

    await pc.setRemoteDescription(offer);
    remoteDescriptionSetRef.current = true;
    await flushIceCandidates();

    if (offer.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendAnswer(otherUserId, buildSignalEnvelope({ description: answer }));

      if (!wasConnectedRef.current && pc.connectionState !== 'connected') {
        stopCallAudio();
        clearRingingTimeout();
        setCallState('connecting');
      }
    }
  }, [buildSignalEnvelope, clearOfferRetryInterval, clearRingingTimeout, ensureCallId, flushIceCandidates, otherUserId, sendAnswer, stopCallAudio]);

  const requestIceRestart = useCallback(async () => {
    const pc = peerConnectionRef.current;
    if (!pc || iceRestartingRef.current || pc.signalingState !== 'stable') return;

    iceRestartingRef.current = true;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      sendOffer(otherUserId, buildSignalEnvelope({ description: offer }));
    } catch (error) {
      console.warn('[Call] ICE restart failed:', error);
    } finally {
      iceRestartingRef.current = false;
    }
  }, [buildSignalEnvelope, otherUserId, sendOffer]);

  const sendNegotiationOffer = useCallback(async () => {
    const pc = peerConnectionRef.current;
    if (!pc || makingOfferRef.current || pc.signalingState !== 'stable') return;

    try {
      makingOfferRef.current = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendOffer(otherUserId, buildSignalEnvelope({ description: offer }));
    } catch (error) {
      console.warn('[Call] Failed to send offer:', error);
    } finally {
      makingOfferRef.current = false;
    }
  }, [buildSignalEnvelope, otherUserId, sendOffer]);

  const startOfferRetryLoop = useCallback(() => {
    if (offerRetryIntervalRef.current) return;
    offerRetryIntervalRef.current = setInterval(() => {
      const pc = peerConnectionRef.current;
      if (!pc || pc.connectionState === 'connected') {
        clearOfferRetryInterval();
        return;
      }
      void sendNegotiationOffer();
    }, 3000);
  }, [clearOfferRetryInterval, sendNegotiationOffer]);

  const cleanup = useCallback(() => {
    if (cleanedUpRef.current) return;
    cleanedUpRef.current = true;

    stopCallAudio();
    clearRingingTimeout();
    clearCallFailTimeout();
    clearDisconnectGraceTimeout();
    clearOfferRetryInterval();

    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    remoteDescriptionSetRef.current = false;
    iceCandidateBufferRef.current = [];
    callIdRef.current = null;
    wasConnectedRef.current = false;
    setIsVideoEnabled(false);
    isVideoEnabledRef.current = false;
  }, [clearCallFailTimeout, clearDisconnectGraceTimeout, clearOfferRetryInterval, clearRingingTimeout, stopCallAudio]);

  const syncTrackStates = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;

    stream.getAudioTracks().forEach((track) => {
      track.enabled = !isMutedRef.current;
    });

    const hasVideo = stream.getVideoTracks().length > 0;
    if (hasVideo !== isVideoEnabledRef.current) {
      setIsVideoEnabled(hasVideo);
      isVideoEnabledRef.current = hasVideo;
    }
  }, []);

  const updateRemoteAspect = useCallback(() => {
    const remoteVideo = remoteVideoRef.current;
    if (!remoteVideo || remoteVideo.videoWidth === 0 || remoteVideo.videoHeight === 0) return;
    setIsRemotePortrait(remoteVideo.videoHeight > remoteVideo.videoWidth);
  }, []);

  const markConnected = useCallback(() => {
    stopCallAudio();
    clearRingingTimeout();
    clearCallFailTimeout();
    clearDisconnectGraceTimeout();
    clearOfferRetryInterval();
    setCallState('connected');
    syncTrackStates();
    wasConnectedRef.current = true;

    if (!callTimerRef.current) {
      callTimerRef.current = setInterval(() => {
        setCallDuration((value) => value + 1);
      }, 1000);
    }
  }, [clearCallFailTimeout, clearDisconnectGraceTimeout, clearOfferRetryInterval, clearRingingTimeout, stopCallAudio, syncTrackStates]);

  const finishAndNavigateBack = useCallback((delayMs: number) => {
    setTimeout(() => {
      navigate(-1);
    }, delayMs);
  }, [navigate]);

  const handleEndCall = useCallback(() => {
    endCall(otherUserId);
    playEndTone();
    cleanup();
    clearIncomingCall();
    try {
      sessionStorage.removeItem('ring.incomingOffer');
    } catch {
      // ignore
    }
    setCallState('ended');
    finishAndNavigateBack(600);
  }, [clearIncomingCall, cleanup, endCall, finishAndNavigateBack, otherUserId]);

  // Keep this effect keyed to call identity only; presence/user-list updates must not tear down active WebRTC sessions.
  useEffect(() => {
    if (Number.isNaN(otherUserId)) return;

    cleanedUpRef.current = false;
    remoteDescriptionSetRef.current = false;
    iceCandidateBufferRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    iceRestartingRef.current = false;
    callIdRef.current = incomingOffer?.callId ?? null;
    wasConnectedRef.current = false;
    clearDisconnectGraceTimeout();
    clearOfferRetryInterval();
    politeRef.current = getCurrentUserId() < otherUserId;

    let mounted = true;
    let waitSocketTimeout: ReturnType<typeof setTimeout> | null = null;

    let sessionOffer: IncomingCallState | null = null;
    try {
      const raw = sessionStorage.getItem('ring.incomingOffer');
      if (raw) {
        sessionOffer = JSON.parse(raw) as IncomingCallState;
      }
    } catch {
      sessionOffer = null;
    }

    const initialIncomingOffer = incomingOffer ?? useWebSocketStore.getState().incomingCall ?? sessionOffer;
    clearIncomingCall();

    const initializeCall = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: true,
        });

        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = stream;

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        stream.getAudioTracks().forEach((track) => {
          track.enabled = !isMutedRef.current;
        });

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        peerConnectionRef.current = pc;

        stream.getTracks().forEach((track) => {
          pc.addTrack(track, stream);
        });

        pc.ontrack = (event) => {
          if (!remoteVideoRef.current || !event.streams[0]) return;
          remoteVideoRef.current.srcObject = event.streams[0];
          void remoteVideoRef.current.play().catch(() => {
            // autoplay can be blocked
          });
          if (event.track.kind === 'video') {
            requestAnimationFrame(updateRemoteAspect);
          }
          markConnected();
        };

        pc.onicecandidate = (event) => {
          if (!event.candidate) return;
          sendIceCandidate(otherUserId, buildSignalEnvelope({ candidate: event.candidate.toJSON() }));
        };

        pc.onconnectionstatechange = () => {
          if (!mounted) return;

          switch (pc.connectionState) {
            case 'connecting':
              if (!wasConnectedRef.current) {
                setCallState('connecting');
              }
              break;
            case 'connected':
              markConnected();
              break;
            case 'disconnected':
              if (!disconnectGraceTimeoutRef.current) {
                disconnectGraceTimeoutRef.current = setTimeout(() => {
                  disconnectGraceTimeoutRef.current = null;
                  if (!mounted || pc.connectionState !== 'disconnected') return;
                  setCallState('connecting');
                  void requestIceRestart();
                }, 2500);
              }
              break;
            case 'failed':
              clearDisconnectGraceTimeout();
              setCallState('connecting');
              void requestIceRestart();
              if (!connectionFailTimeoutRef.current) {
                connectionFailTimeoutRef.current = setTimeout(() => {
                  if (!mounted || pc.connectionState !== 'failed') return;
                  playEndTone();
                  setCallState('ended');
                  cleanup();
                  finishAndNavigateBack(1200);
                }, 8000);
              }
              break;
            case 'closed':
              break;
          }
        };

        pc.oniceconnectionstatechange = () => {
          if (!mounted) return;

          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            markConnected();
            return;
          }

          if (pc.iceConnectionState === 'disconnected' && !disconnectGraceTimeoutRef.current) {
            disconnectGraceTimeoutRef.current = setTimeout(() => {
              disconnectGraceTimeoutRef.current = null;
              if (!mounted || pc.iceConnectionState !== 'disconnected') return;
              setCallState('connecting');
              void requestIceRestart();
            }, 2500);
          }

          if (pc.iceConnectionState === 'failed') {
            clearDisconnectGraceTimeout();
            setCallState('connecting');
            void requestIceRestart();
          }
        };

        if (isIncoming) {
          const offerSource = initialIncomingOffer?.data;
          if (offerSource) {
            const parsed = parseSignalData(offerSource);
            if (parsed.description?.type === 'offer') {
              setCallState('connecting');
              await handleRemoteOffer(parsed.description, initialIncomingOffer?.callId ?? parsed.callId);
              try {
                sessionStorage.removeItem('ring.incomingOffer');
              } catch {
                // ignore
              }
            } else {
              ensureCallId(createCallId());
              await sendNegotiationOffer();
              startOfferRetryLoop();
              setCallState('connecting');
            }
          } else {
            // Reload recovery: if no cached incoming offer exists, re-initiate signaling.
            ensureCallId(createCallId());
            await sendNegotiationOffer();
            startOfferRetryLoop();
            setCallState('connecting');
          }
        } else {
          ensureCallId(createCallId());
          await sendNegotiationOffer();
          startOfferRetryLoop();

          setCallState('ringing');
          stopAudioRef.current = playCallingTone();
          ringingTimeoutRef.current = setTimeout(() => {
            if (!mounted) return;
            if (peerConnectionRef.current?.connectionState !== 'connected') {
              handleEndCall();
            }
          }, 45000);
        }
      } catch (error) {
        console.error('[Call] Failed to initialize call:', error);
        if (!mounted) return;
        cleanup();
        navigate(-1);
      }
    };

    const waitForSocketAndStart = () => {
      if (!mounted) return;
      if (useWebSocketStore.getState().isConnected) {
        void initializeCall();
        return;
      }

      waitSocketTimeout = setTimeout(waitForSocketAndStart, 400);
    };

    waitForSocketAndStart();

    const onCallAnswered = (event: Event) => {
      const detail = (event as CustomEvent<CallAnsweredDetail>).detail;
      if (!detail || detail.from !== otherUserId) return;

      if (detail.callId && callIdRef.current && detail.callId !== callIdRef.current) {
        return;
      }

      const parsed = parseSignalData(detail.data);
      const answer = parsed.description;
      if (!answer || answer.type !== 'answer') return;

      stopCallAudio();
      clearRingingTimeout();
      clearOfferRetryInterval();
      if (!wasConnectedRef.current) {
        setCallState('connecting');
      }

      void handleRemoteDescription(answer).catch((error) => {
        console.error('[Call] Failed to set remote answer:', error);
      });
    };

    const onIceCandidate = (event: Event) => {
      const detail = (event as CustomEvent<IceCandidateDetail>).detail;
      if (!detail || detail.from !== otherUserId) return;

      if (detail.callId && callIdRef.current && detail.callId !== callIdRef.current) {
        return;
      }

      const parsed = parseSignalData(detail.candidate);
      const candidate = parsed.candidate;
      if (!candidate) return;

      if (remoteDescriptionSetRef.current && peerConnectionRef.current) {
        void peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch((error) => {
          console.warn('[Call] Failed to add ICE candidate:', error);
        });
      } else {
        iceCandidateBufferRef.current.push(candidate);
      }
    };

    const onCallEnded = (event: Event) => {
      const detail = (event as CustomEvent<{ from: number }>).detail;
      if (!detail || detail.from !== otherUserId || !mounted) return;

      playEndTone();
      setCallState('ended');
      cleanup();
      clearIncomingCall();

      try {
        sessionStorage.removeItem('ring.incomingOffer');
      } catch {
        // ignore
      }

      finishAndNavigateBack(1000);
    };

    const onIncomingOffer = (event: Event) => {
      const detail = (event as CustomEvent<IncomingCallDetail>).detail;
      if (!detail || detail.from !== otherUserId) return;

      const parsed = parseSignalData(detail.data);
      const offer = parsed.description;
      if (!offer || offer.type !== 'offer') return;

      void handleRemoteOffer(offer, detail.callId ?? parsed.callId).then(() => {
        try {
          sessionStorage.removeItem('ring.incomingOffer');
        } catch {
          // ignore
        }
      }).catch((error) => {
        console.error('[Call] Failed to handle remote offer:', error);
      });
    };

    window.addEventListener('call-answered', onCallAnswered);
    window.addEventListener('ice-candidate', onIceCandidate);
    window.addEventListener('call-ended', onCallEnded);
    window.addEventListener('incoming-call', onIncomingOffer);

    return () => {
      mounted = false;
      window.removeEventListener('call-answered', onCallAnswered);
      window.removeEventListener('ice-candidate', onIceCandidate);
      window.removeEventListener('call-ended', onCallEnded);
      window.removeEventListener('incoming-call', onIncomingOffer);

      if (waitSocketTimeout) {
        clearTimeout(waitSocketTimeout);
        waitSocketTimeout = null;
      }

      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDisconnectGraceTimeout, clearOfferRetryInterval, markConnected, otherUserId, isIncoming, sendNegotiationOffer, startOfferRetryLoop]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const nextMuted = !isMutedRef.current;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });

    isMutedRef.current = nextMuted;
    setIsMuted(nextMuted);
  }, []);

  const toggleVideo = useCallback(async () => {
    const pc = peerConnectionRef.current;
    const stream = localStreamRef.current;
    if (!stream) return;

    if (!isVideoEnabledRef.current) {
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
        const [track] = videoStream.getVideoTracks();
        if (!track) return;
        if ('contentHint' in track) {
          track.contentHint = 'detail';
        }

        stream.addTrack(track);

        if (pc) {
          pc.addTrack(track, stream);
          makingOfferRef.current = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendOffer(otherUserId, buildSignalEnvelope({ description: offer }));
        }

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        isVideoEnabledRef.current = true;
        setIsVideoEnabled(true);
      } catch (error) {
        console.warn('[Call] Failed to enable video:', error);
      } finally {
        makingOfferRef.current = false;
      }
      return;
    }

    const tracks = stream.getVideoTracks();
    if (tracks.length === 0) {
      isVideoEnabledRef.current = false;
      setIsVideoEnabled(false);
      return;
    }

    for (const track of tracks) {
      track.stop();
      stream.removeTrack(track);

      if (pc) {
        const sender = pc.getSenders().find((entry) => entry.track === track);
        if (sender) {
          pc.removeTrack(sender);
        }
      }
    }

    if (pc) {
      try {
        makingOfferRef.current = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendOffer(otherUserId, buildSignalEnvelope({ description: offer }));
      } catch (error) {
        console.warn('[Call] Failed to disable video:', error);
      } finally {
        makingOfferRef.current = false;
      }
    }

    isVideoEnabledRef.current = false;
    setIsVideoEnabled(false);
  }, [buildSignalEnvelope, otherUserId, sendOffer]);

  const toggleSpeaker = useCallback(async () => {
    const remoteVideo = remoteVideoRef.current;
    if (!remoteVideo) return;

    const nextSpeakerOn = !isSpeakerOn;

    if ('setSinkId' in remoteVideo && typeof (remoteVideo as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId === 'function') {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((device) => device.kind === 'audiooutput');

        if (outputs.length > 0) {
          const secondary = outputs[1]?.deviceId;
          const sinkId = nextSpeakerOn ? 'default' : (secondary ?? 'default');
          await (remoteVideo as HTMLMediaElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(sinkId);
          setIsSpeakerOn(nextSpeakerOn);
          return;
        }
      } catch (error) {
        console.warn('[Call] setSinkId failed:', error);
      }
    }

    remoteVideo.volume = nextSpeakerOn ? 1 : 0.5;
    setIsSpeakerOn(nextSpeakerOn);
  }, [isSpeakerOn]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col">
      <div className="pt-safe px-4 py-2 flex items-center justify-between text-white">
        <span className="text-sm font-medium">
          {callState === 'connecting' && 'Connecting...'}
          {callState === 'ringing' && 'Ringing...'}
          {callState === 'connected' && formatDuration(callDuration)}
          {callState === 'ended' && 'Call ended'}
        </span>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs">{isConnected ? 'Secure' : 'Reconnecting'}</span>
        </div>
      </div>

      <div className="flex-1 relative">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          onLoadedMetadata={updateRemoteAspect}
          className={`absolute inset-0 w-full h-full bg-black ${isRemotePortrait ? 'object-cover md:object-contain' : 'object-cover'}`}
        />

        {(callState === 'connecting' || callState === 'ringing') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
            <div className="relative mb-4">
              <div className="absolute inset-0 w-24 h-24 rounded-full bg-primary-500/20 animate-ping" />
              <div className="relative w-24 h-24 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-3xl font-bold">
                {displayInitial}
              </div>
            </div>
            <h2 className="text-2xl font-bold">{displayName}</h2>
            <p className="text-slate-300 mt-2 animate-pulse">
              {callState === 'connecting' ? 'Connecting...' : 'Ringing...'}
            </p>
          </div>
        )}

        <div className="absolute top-4 right-4 w-32 h-44 rounded-xl overflow-hidden border-2 border-white/20 shadow-lg">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover ${!isVideoEnabled ? 'hidden' : ''}`}
          />
          {!isVideoEnabled && (
            <div className="w-full h-full bg-slate-800 flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg">
                {displayInitial}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="glass px-6 py-6 pb-safe">
        <div className="flex items-center justify-center gap-6">
          <button
            onClick={toggleMute}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              isMuted ? 'bg-red-500 text-white' : 'bg-slate-700 text-white'
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isMuted ? (
                <>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5a3 3 0 116 0v6a3 3 0 01-6 0V5z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18" />
                </>
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              )}
            </svg>
          </button>

          <button
            onClick={() => void toggleVideo()}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              !isVideoEnabled ? 'bg-red-500 text-white' : 'bg-slate-700 text-white'
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isVideoEnabled ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              ) : (
                <>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18" />
                </>
              )}
            </svg>
          </button>

          <button
            onClick={handleEndCall}
            className="w-16 h-16 rounded-full bg-red-500 text-white flex items-center justify-center shadow-lg shadow-red-500/30"
          >
            <svg className="w-8 h-8 rotate-[135deg]" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
            </svg>
          </button>

          <button
            onClick={() => void toggleSpeaker()}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors sm:hidden ${
              isSpeakerOn ? 'bg-primary-600 text-white' : 'bg-slate-700 text-white'
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
