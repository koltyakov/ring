import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useUsersStore } from '../stores/usersStore'
import { useWebSocketStore } from '../stores/websocketStore'

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export default function CallPage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const user = useUsersStore(state => state.getUserById(parseInt(userId!, 10)))
  const sendOffer = useWebSocketStore(state => state.sendCallOffer)
  const sendAnswer = useWebSocketStore(state => state.sendCallAnswer)
  const sendIceCandidate = useWebSocketStore(state => state.sendIceCandidate)
  const endCall = useWebSocketStore(state => state.endCall)
  const isConnected = useWebSocketStore(state => state.isConnected)

  const [callState, setCallState] = useState<'connecting' | 'ringing' | 'connected' | 'ended'>('connecting')
  const [isMuted, setIsMuted] = useState(false)
  const [isVideoEnabled, setIsVideoEnabled] = useState(true)
  const [isSpeakerOn, setIsSpeakerOn] = useState(false)
  const [callDuration, setCallDuration] = useState(0)

  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const otherUserId = parseInt(userId!, 10)
  const isIncoming = window.location.search.includes('incoming=true')

  useEffect(() => {
    if (!user || !isConnected) return

    initializeCall()

    // Listen for WebSocket events
    const handleAnswer = (e: CustomEvent) => {
      const { data } = e.detail
      handleCallAnswer(data)
    }

    const handleIce = (e: CustomEvent) => {
      const { candidate } = e.detail
      handleIceCandidate(candidate)
    }

    const handleEnd = () => {
      setCallState('ended')
      cleanup()
      setTimeout(() => navigate(-1), 1000)
    }

    window.addEventListener('call-answered', handleAnswer as EventListener)
    window.addEventListener('ice-candidate', handleIce as EventListener)
    window.addEventListener('call-ended', handleEnd)

    return () => {
      window.removeEventListener('call-answered', handleAnswer as EventListener)
      window.removeEventListener('ice-candidate', handleIce as EventListener)
      window.removeEventListener('call-ended', handleEnd)
      cleanup()
    }
  }, [user, isConnected])

  const initializeCall = async () => {
    try {
      // Get local media
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      })
      localStreamRef.current = stream

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      // Create peer connection
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      peerConnectionRef.current = pc

      // Add local tracks
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream)
      })

      // Handle remote stream
      pc.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0]
        }
      }

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendIceCandidate(otherUserId, event.candidate)
        }
      }

      // Handle connection state
      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case 'connected':
            setCallState('connected')
            startCallTimer()
            break
          case 'disconnected':
          case 'failed':
            setCallState('ended')
            break
        }
      }

      if (isIncoming) {
        // Wait for offer
        const handleIncomingOffer = (e: CustomEvent) => {
          const { from, data } = e.detail
          if (from === otherUserId) {
            handleCallOffer(data)
            window.removeEventListener('incoming-call', handleIncomingOffer as EventListener)
          }
        }
        window.addEventListener('incoming-call', handleIncomingOffer as EventListener)
      } else {
        // Initiate call
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        sendOffer(otherUserId, offer)
        setCallState('ringing')
      }
    } catch (error) {
      console.error('Failed to initialize call:', error)
      navigate(-1)
    }
  }

  const handleCallOffer = async (offer: RTCSessionDescriptionInit) => {
    const pc = peerConnectionRef.current
    if (!pc) return

    await pc.setRemoteDescription(new RTCSessionDescription(offer))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    sendAnswer(otherUserId, answer)
  }

  const handleCallAnswer = async (answer: RTCSessionDescriptionInit) => {
    const pc = peerConnectionRef.current
    if (!pc) return

    await pc.setRemoteDescription(new RTCSessionDescription(answer))
  }

  const handleIceCandidate = async (candidate: RTCIceCandidateInit) => {
    const pc = peerConnectionRef.current
    if (!pc) return

    await pc.addIceCandidate(new RTCIceCandidate(candidate))
  }

  const startCallTimer = () => {
    callTimerRef.current = setInterval(() => {
      setCallDuration(prev => prev + 1)
    }, 1000)
  }

  const cleanup = () => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current)
    }

    localStreamRef.current?.getTracks().forEach(track => track.stop())
    peerConnectionRef.current?.close()
  }

  const handleEndCall = () => {
    endCall(otherUserId)
    cleanup()
    navigate(-1)
  }

  const toggleMute = () => {
    localStreamRef.current?.getAudioTracks().forEach(track => {
      track.enabled = !track.enabled
    })
    setIsMuted(!isMuted)
  }

  const toggleVideo = () => {
    localStreamRef.current?.getVideoTracks().forEach(track => {
      track.enabled = !track.enabled
    })
    setIsVideoEnabled(!isVideoEnabled)
  }

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  if (!user) return null

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

        {/* User info overlay */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
          {(callState === 'connecting' || callState === 'ringing') && (
            <>
              <div className="w-24 h-24 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-3xl font-bold mb-4">
                {user.username[0].toUpperCase()}
              </div>
              <h2 className="text-2xl font-bold">{user.username}</h2>
              <p className="text-slate-300 mt-2">
                {callState === 'connecting' ? 'Calling...' : 'Ringing...'}
              </p>
            </>
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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" clipRule="evenodd" />
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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              )}
            </svg>
          </button>

          {/* End call */}
          <button
            onClick={handleEndCall}
            className="w-16 h-16 rounded-full bg-red-500 text-white flex items-center justify-center shadow-lg shadow-red-500/30"
          >
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
            </svg>
          </button>

          {/* Speaker */}
          <button
            onClick={() => setIsSpeakerOn(!isSpeakerOn)}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
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
  )
}
