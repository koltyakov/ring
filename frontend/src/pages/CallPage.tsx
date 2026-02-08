import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useUsersStore } from '../stores/usersStore';
import { useWebSocketStore } from '../stores/websocketStore';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ──────────────────────────── Audio helpers ────────────────────────────

let audioCtx: AudioContext | null = null;
function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/**
 * Play a repeating outgoing "calling" tone (dual-tone, like a real phone).
 * Returns a stop() function.
 */
function playCallingTone(): () => void {
  const ctx = getAudioCtx();
  const gain = ctx.createGain();
  gain.gain.value = 0.08;
  gain.connect(ctx.destination);

  let stopped = false;
  let currentOscs: OscillatorNode[] = [];
  let timeout: ReturnType<typeof setTimeout>;

  const ring = () => {
    if (stopped) return;
    // US-style ringback: 440 Hz + 480 Hz for 2 s, silence 4 s
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
    clearTimeout(timeout);
    currentOscs.forEach(o => { try { o.stop(); } catch { /* already stopped */ } });
    currentOscs = [];
  };
}

/**
 * Play a repeating "ring-ring" pattern for the callee.
 * Returns a stop() function.
 */
function playRingtone(): () => void {
  const ctx = getAudioCtx();
  const gain = ctx.createGain();
  gain.gain.value = 0.12;
  gain.connect(ctx.destination);

  let stopped = false;
  let currentOscs: OscillatorNode[] = [];
  let timeout: ReturnType<typeof setTimeout>;

  const ring = () => {
    if (stopped) return;
    const oscs: OscillatorNode[] = [];
    // Two short bursts
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 440 + i * 40;
      osc.connect(gain);
      const start = ctx.currentTime + i * 0.3;
      osc.start(start);
      osc.stop(start + 0.2);
      oscs.push(osc);
    }
    currentOscs = oscs;
    timeout = setTimeout(ring, 2500);
  };
  ring();

  return () => {
    stopped = true;
    clearTimeout(timeout);
    currentOscs.forEach(o => { try { o.stop(); } catch { /* already stopped */ } });
    currentOscs = [];
  };
}

/** Short "call ended" beep */
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
    /* ignore */
  }
}

// ───────────────────────────── Component ──────────────────────────────

interface IncomingCallState {
  from: number
  data: unknown
}

export default function CallPage() {
  const { userId } = useParams<{ userId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const user = useUsersStore(state => state.getUserById(parseInt(userId!, 10)));
  const sendOffer = useWebSocketStore(state => state.sendCallOffer);
  const sendAnswer = useWebSocketStore(state => state.sendCallAnswer);
  const sendIceCandidate = useWebSocketStore(state => state.sendIceCandidate);
  const endCall = useWebSocketStore(state => state.endCall);
  const isConnected = useWebSocketStore(state => state.isConnected);

  const [callState, setCallState] = useState<'connecting' | 'ringing' | 'connected' | 'ended'>('connecting');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);
  const [callDuration, setCallDuration] = useState(0);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionFailTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const incomingOfferRef = useRef<IncomingCallState | null>(null);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const iceRestartingRef = useRef(false);
  const politeRef = useRef(false);

  // ICE candidate buffer — holds candidates that arrive before remote description is set
  const iceCandidateBuffer = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescriptionSet = useRef(false);

  // Audio stop handles
  const stopAudioRef = useRef<(() => void) | null>(null);

  // Ringing timeout ref (auto-cancel if nobody answers)
  const ringingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prevent double-cleanup
  const cleanedUpRef = useRef(false);

  const clearIncomingCall = useWebSocketStore(state => state.clearIncomingCall);

  const otherUserId = parseInt(userId!, 10);
  const isIncoming = window.location.search.includes('incoming=true');
  const incomingOffer = (location.state as { incomingOffer?: IncomingCallState } | null)?.incomingOffer;

  const getCurrentUserId = () => {
    try {
      const token = localStorage.getItem('token');
      return token ? JSON.parse(atob(token.split('.')[1])).user_id : 0;
    } catch {
      return 0;
    }
  };

  // ─── Flush buffered ICE candidates once remote description is set ───
  const flushIceCandidates = useCallback(async () => {
    const pc = peerConnectionRef.current;
    if (!pc) return;
    const buffered = iceCandidateBuffer.current.splice(0);
    for (const candidate of buffered) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[Call] Failed to add buffered ICE candidate:', err);
      }
    }
  }, []);

  const handleRemoteDescription = useCallback(async (desc: RTCSessionDescriptionInit) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(desc));
    remoteDescriptionSet.current = true;
    await flushIceCandidates();
  }, [flushIceCandidates]);

  const handleRemoteOffer = useCallback(async (desc: RTCSessionDescriptionInit) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;
    const offer = new RTCSessionDescription(desc);
    const offerCollision = offer.type === 'offer' && (makingOfferRef.current || pc.signalingState !== 'stable');
    ignoreOfferRef.current = !politeRef.current && offerCollision;
    if (ignoreOfferRef.current) {
      console.warn('[Call] Ignoring offer due to collision');
      return;
    }

    if (offerCollision && politeRef.current && pc.signalingState !== 'stable') {
      try {
        await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
      } catch {
        // Rollback can fail on some browsers; proceed with caution.
      }
    }

    await pc.setRemoteDescription(offer);
    remoteDescriptionSet.current = true;
    await flushIceCandidates();

    if (offer.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendAnswer(otherUserId, answer);
      if (pc.connectionState !== 'connected') {
        setCallState('connecting');
        stopAudioRef.current?.();
        stopAudioRef.current = null;
        if (ringingTimeoutRef.current) {
          clearTimeout(ringingTimeoutRef.current);
          ringingTimeoutRef.current = null;
        }
      }
    }
  }, [flushIceCandidates, otherUserId, sendAnswer]);

  const requestIceRestart = useCallback(async () => {
    const pc = peerConnectionRef.current;
    if (!pc || iceRestartingRef.current) return;
    if (pc.signalingState !== 'stable') return;
    iceRestartingRef.current = true;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      sendOffer(otherUserId, offer);
    } catch (err) {
      console.warn('[Call] ICE restart failed:', err);
    } finally {
      iceRestartingRef.current = false;
    }
  }, [otherUserId, sendOffer]);

  // ─── Cleanup everything ───
  const cleanup = useCallback(() => {
    if (cleanedUpRef.current) return;
    cleanedUpRef.current = true;

    // Stop audio
    stopAudioRef.current?.();
    stopAudioRef.current = null;

    // Clear ringing timeout
    if (ringingTimeoutRef.current) {
      clearTimeout(ringingTimeoutRef.current);
      ringingTimeoutRef.current = null;
    }

    // Stop call timer
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }

    if (connectionFailTimeoutRef.current) {
      clearTimeout(connectionFailTimeoutRef.current);
      connectionFailTimeoutRef.current = null;
    }

    // Stop all local media tracks (camera, mic)
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.stop();
      });
      localStreamRef.current = null;
    }

    // Detach video elements
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
  }, []);

  // ─── Handle end call ───
  const handleEndCall = useCallback(() => {
    endCall(otherUserId);
    playEndTone();
    cleanup();
    setCallState('ended');
    clearIncomingCall();
    try {
      sessionStorage.removeItem('ring.incomingOffer');
    } catch {
      // Ignore storage errors
    }
    setTimeout(() => navigate(-1), 600);
  }, [endCall, otherUserId, cleanup, navigate, clearIncomingCall]);

  // ─── Main call setup effect ───
  useEffect(() => {
    if (!user) return;
    // Reset for this mount
    cleanedUpRef.current = false;
    remoteDescriptionSet.current = false;
    iceCandidateBuffer.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    iceRestartingRef.current = false;
    politeRef.current = getCurrentUserId() < otherUserId;

    // Capture any incoming offer before clearing store state
    let sessionOffer: IncomingCallState | null = null;
    try {
      const raw = sessionStorage.getItem('ring.incomingOffer');
      if (raw) sessionOffer = JSON.parse(raw) as IncomingCallState;
    } catch {
      sessionOffer = null;
    }
    incomingOfferRef.current = incomingOffer ?? useWebSocketStore.getState().incomingCall ?? sessionOffer;

    // Clear any incoming call state so the Layout modal doesn't re-appear
    clearIncomingCall();

    let mounted = true;
    let startTimer: ReturnType<typeof setTimeout> | null = null;

    const initializeCall = async () => {
      try {
        // 1. Get local media
        const stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: true,
        });

        if (!mounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // 2. Create peer connection
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        peerConnectionRef.current = pc;

        // Add local tracks to pc
        stream.getTracks().forEach(track => {
          pc.addTrack(track, stream);
        });

        // Handle incoming remote tracks
        pc.ontrack = (event) => {
          if (remoteVideoRef.current && event.streams[0]) {
            remoteVideoRef.current.srcObject = event.streams[0];
            remoteVideoRef.current.play().catch(() => {
              // Autoplay might be blocked; user interaction will start playback.
            });
          }
        };

        // Send ICE candidates to peer
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            sendIceCandidate(otherUserId, event.candidate);
          }
        };

        // Monitor connection state
        pc.onconnectionstatechange = () => {
          if (!mounted) return;
          console.log('[Call] connectionState:', pc.connectionState);
          switch (pc.connectionState) {
            case 'connecting':
              setCallState('connecting');
              break;
            case 'connected':
              setCallState('connected');
              // Stop ringing/calling sounds
              stopAudioRef.current?.();
              stopAudioRef.current = null;
              if (connectionFailTimeoutRef.current) {
                clearTimeout(connectionFailTimeoutRef.current);
                connectionFailTimeoutRef.current = null;
              }
              // Start call timer
              if (!callTimerRef.current) {
                callTimerRef.current = setInterval(() => {
                  setCallDuration(prev => prev + 1);
                }, 1000);
              }
              break;
            case 'disconnected':
              console.warn('[Call] Peer disconnected, waiting for recovery…');
              break;
            case 'failed':
              console.warn('[Call] Peer connection failed, attempting recovery');
              requestIceRestart();
              if (!connectionFailTimeoutRef.current) {
                connectionFailTimeoutRef.current = setTimeout(() => {
                  if (!mounted) return;
                  if (pc.connectionState === 'failed') {
                    console.error('[Call] Peer connection failed to recover');
                    playEndTone();
                    setCallState('ended');
                    cleanup();
                    setTimeout(() => { if (mounted) navigate(-1); }, 1200);
                  }
                }, 8000);
              }
              break;
            case 'closed':
              break;
          }
        };

        // Monitor ICE connection state (more granular)
        pc.oniceconnectionstatechange = () => {
          if (!mounted) return;
          console.log('[Call] iceConnectionState:', pc.iceConnectionState);
          if (pc.iceConnectionState === 'disconnected') {
            setCallState('connecting');
            setTimeout(() => {
              if (!mounted) return;
              if (pc.iceConnectionState === 'disconnected') {
                console.warn('[Call] ICE disconnected, attempting restart');
                requestIceRestart();
              }
            }, 1500);
          }
          if (pc.iceConnectionState === 'failed') {
            console.warn('[Call] ICE failed, attempting restart');
            requestIceRestart();
          }
        };

        // 3. Initiate or accept
        if (isIncoming) {
          // ── Incoming call: read the offer from store directly ──
          // The offer was already stored before we navigated here.
          const stored = incomingOfferRef.current;
          if (stored?.data) {
            console.log('[Call] Using stored offer from incomingCall state');
            setCallState('connecting');
            await handleRemoteOffer(stored.data as RTCSessionDescriptionInit);
            try {
              sessionStorage.removeItem('ring.incomingOffer');
            } catch {
              // Ignore storage errors
            }
          } else {
            // Fallback: wait for offer event (rare edge case)
            console.warn('[Call] No stored offer found, waiting for event…');
            setCallState('ringing');
            stopAudioRef.current = playRingtone();
          }
        } else {
          // ── Outgoing call: create and send offer ──
          try {
            makingOfferRef.current = true;
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendOffer(otherUserId, offer);
          } finally {
            makingOfferRef.current = false;
          }
          setCallState('ringing');

          // Play calling tone while waiting for the other party
          stopAudioRef.current = playCallingTone();

          // Auto-cancel if nobody answers within 45 seconds
          ringingTimeoutRef.current = setTimeout(() => {
            if (!mounted) return;
            const currentState = peerConnectionRef.current?.connectionState;
            if (currentState !== 'connected') {
              console.log('[Call] Ringing timed out after 45s');
              handleEndCall();
            }
          }, 45_000);
        }
      } catch (error) {
        console.error('[Call] Failed to initialize call:', error);
        if (mounted) {
          cleanup();
          navigate(-1);
        }
      }
    };

    const waitForSocketAndStart = () => {
      if (!mounted) return;
      if (!useWebSocketStore.getState().isConnected) {
        startTimer = setTimeout(waitForSocketAndStart, 500);
        return;
      }
      initializeCall();
    };

    waitForSocketAndStart();

    // ── Signaling event listeners ──

    const handleAnswer = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const { data } = detail;
      if (!data) return;
      const pc = peerConnectionRef.current;
      if (!pc) return;
      // Caller: stop ringback and move to connecting while ICE completes
      stopAudioRef.current?.();
      stopAudioRef.current = null;
      if (ringingTimeoutRef.current) {
        clearTimeout(ringingTimeoutRef.current);
        ringingTimeoutRef.current = null;
      }
      setCallState('connecting');
      handleRemoteDescription(data as RTCSessionDescriptionInit)
        .catch(err => console.error('[Call] Failed to set remote answer:', err));
    };

    const handleIce = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const { candidate } = detail;
      if (!candidate) return;

      if (remoteDescriptionSet.current && peerConnectionRef.current) {
        peerConnectionRef.current
          .addIceCandidate(new RTCIceCandidate(candidate))
          .catch(err => console.warn('[Call] Failed to add ICE candidate:', err));
      } else {
        // Buffer until remote description is set
        iceCandidateBuffer.current.push(candidate);
      }
    };

    const handleEnd = () => {
      if (!mounted) return;
      playEndTone();
      setCallState('ended');
      cleanup();
      clearIncomingCall();
      try {
        sessionStorage.removeItem('ring.incomingOffer');
      } catch {
        // Ignore storage errors
      }
      setTimeout(() => { if (mounted) navigate(-1); }, 1000);
    };

    // Fallback listener for late incoming offers
    const handleIncomingOffer = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const { from, data } = detail;
      if (from !== otherUserId || !data) return;
      const pc = peerConnectionRef.current;
      if (!pc) return;

      handleRemoteOffer(data as RTCSessionDescriptionInit)
        .then(() => {
          try {
            sessionStorage.removeItem('ring.incomingOffer');
          } catch {
            // Ignore storage errors
          }
        })
        .catch(err => console.error('[Call] Failed to handle offer:', err));
    };

    window.addEventListener('call-answered', handleAnswer);
    window.addEventListener('ice-candidate', handleIce);
    window.addEventListener('call-ended', handleEnd);
    window.addEventListener('incoming-call', handleIncomingOffer);

    return () => {
      mounted = false;
      window.removeEventListener('call-answered', handleAnswer);
      window.removeEventListener('ice-candidate', handleIce);
      window.removeEventListener('call-ended', handleEnd);
      window.removeEventListener('incoming-call', handleIncomingOffer);
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ─── Toggle controls ───
  const toggleMute = () => {
    const nextMuted = !isMuted;
    localStreamRef.current?.getAudioTracks().forEach(track => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  };

  const toggleVideo = async () => {
    const pc = peerConnectionRef.current;
    const stream = localStreamRef.current;
    if (!stream) return;

    if (!isVideoEnabled) {
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const [track] = videoStream.getVideoTracks();
        if (!track) return;
        stream.addTrack(track);
        if (pc) {
          pc.addTrack(track, stream);
          makingOfferRef.current = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendOffer(otherUserId, offer);
        }
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        setIsVideoEnabled(true);
      } catch (err) {
        console.warn('[Call] Failed to enable video:', err);
      } finally {
        makingOfferRef.current = false;
      }
      return;
    }

    const tracks = stream.getVideoTracks();
    if (tracks.length === 0) {
      setIsVideoEnabled(false);
      return;
    }

    for (const track of tracks) {
      track.stop();
      stream.removeTrack(track);
      if (pc) {
        const sender = pc.getSenders().find(s => s.track === track);
        if (sender) pc.removeTrack(sender);
      }
    }

    if (pc) {
      try {
        makingOfferRef.current = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendOffer(otherUserId, offer);
      } catch (err) {
        console.warn('[Call] Failed to disable video:', err);
      } finally {
        makingOfferRef.current = false;
      }
    }

    setIsVideoEnabled(false);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (!user) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col">
      {/* Status bar */}
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

      {/* Video area */}
      <div className="flex-1 relative">
        {/* Remote video (full screen) */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />

        {/* Pulsing animation while ringing/connecting */}
        {(callState === 'connecting' || callState === 'ringing') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
            <div className="relative mb-4">
              <div className="absolute inset-0 w-24 h-24 rounded-full bg-primary-500/20 animate-ping" />
              <div className="relative w-24 h-24 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-3xl font-bold">
                {user.username[0].toUpperCase()}
              </div>
            </div>
            <h2 className="text-2xl font-bold">{user.username}</h2>
            <p className="text-slate-300 mt-2 animate-pulse">
              {callState === 'connecting' ? 'Connecting...' : 'Ringing...'}
            </p>
          </div>
        )}

        {/* Local video (picture in picture) */}
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
                {user.username[0].toUpperCase()}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="glass px-6 py-6 pb-safe">
        <div className="flex items-center justify-center gap-6">
          {/* Mute */}
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

          {/* Video */}
          <button
            onClick={toggleVideo}
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

          {/* End call */}
          <button
            onClick={handleEndCall}
            className="w-16 h-16 rounded-full bg-red-500 text-white flex items-center justify-center shadow-lg shadow-red-500/30"
          >
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15.46l-5.27-1.76a1 1 0 00-1.21.5l-1.1 2.2a11.05 11.05 0 01-5.5-5.5l2.2-1.1a1 1 0 00.5-1.21L9.45 3.99A1 1 0 008.5 3H5a2 2 0 00-2 2v1c0 8.28 6.72 15 15 15h1a2 2 0 002-2v-3.54a1 1 0 00-.7-.99z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 6l4 4m0-4l-4 4" />
            </svg>
          </button>

          {/* Speaker (mobile only) */}
          <button
            onClick={() => setIsSpeakerOn(!isSpeakerOn)}
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
