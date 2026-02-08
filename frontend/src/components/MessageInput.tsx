import { useState, useRef, useCallback } from 'react';
import { useMessagesStore } from '../stores/messagesStore';
import { useWebSocketStore } from '../stores/websocketStore';

interface MessageInputProps {
  userId: number
}

export default function MessageInput({ userId }: MessageInputProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendMessage = useMessagesStore(state => state.sendMessage);
  const sendTyping = useWebSocketStore(state => state.sendTyping);

  const handleTyping = useCallback(() => {
    sendTyping(userId, true);
    
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    
    typingTimeoutRef.current = setTimeout(() => {
      sendTyping(userId, false);
    }, 3000);
  }, [userId, sendTyping]);

  const clearMessages = useMessagesStore(state => state.clearMessages);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || isSending) return;

    // Check for /clear command
    if (message.trim() === '/clear') {
      setIsSending(true);
      setError(null);
      try {
        await clearMessages(userId);
        setMessage('');
      } catch (err) {
        console.error('Failed to clear messages:', err);
        setError('Failed to clear. Tap to retry.');
      } finally {
        setIsSending(false);
      }
      return;
    }

    setIsSending(true);
    setError(null);
    try {
      await sendMessage(userId, message.trim());
      setMessage('');
      sendTyping(userId, false);
    } catch (err) {
      console.error('Failed to send message:', err);
      setError('Failed to send. Tap to retry.');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="glass border-t border-slate-800 p-3 pb-safe">
      {error && (
        <div className="text-xs text-red-400 text-center mb-2 cursor-pointer" onClick={handleSubmit as any}>
          {error}
        </div>
      )}
      <div className="flex items-center gap-2 bg-slate-800/50 rounded-full px-4 py-2">
        <input
          type="text"
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            handleTyping();
          }}
          placeholder="Message..."
          className="flex-1 bg-transparent text-white placeholder-slate-400 outline-none text-sm"
          disabled={isSending}
        />
        <button
          type="submit"
          disabled={!message.trim() || isSending}
          className="p-2 rounded-full bg-primary-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors hover:bg-primary-500"
        >
          {isSending ? (
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          )}
        </button>
      </div>
    </form>
  );
}
