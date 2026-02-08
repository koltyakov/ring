import { useEffect, useRef } from 'react';
import { format } from 'date-fns';
import { useMessagesStore } from '../stores/messagesStore';
import { useUsersStore } from '../stores/usersStore';

interface MessageListProps {
  userId: number
}

export default function MessageList({ userId }: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messages = useMessagesStore(state => state.getMessagesForUser(userId));
  const isLoading = useMessagesStore(state => state.isLoading);
  const fetchMessages = useMessagesStore(state => state.fetchMessages);
  const typing = useMessagesStore(state => state.typingUsers.get(userId));
  useUsersStore(state => state.getUserById(userId)); // prefetch user data

  useEffect(() => {
    fetchMessages(userId);
  }, [userId, fetchMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  const token = localStorage.getItem('token');
  const currentUserId = token ? JSON.parse(atob(token.split('.')[1])).user_id : 0;

  if (isLoading && messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
      </div>
    );
  }

  const visibleMessages = messages.filter(msg => Boolean(msg.decryptedContent));

  // Group messages by date
  const groupedMessages: { date: string; items: typeof visibleMessages }[] = [];
  visibleMessages.forEach(msg => {
    const date = format(new Date(msg.timestamp), 'MMMM d, yyyy');
    const lastGroup = groupedMessages[groupedMessages.length - 1];
    if (lastGroup && lastGroup.date === date) {
      lastGroup.items.push(msg);
    } else {
      groupedMessages.push({ date, items: [msg] });
    }
  });

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
      {visibleMessages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-slate-400 text-center">
          <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center mb-4">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <p className="font-medium">Start a secure conversation</p>
          <p className="text-sm mt-1">All messages are end-to-end encrypted</p>
        </div>
      ) : (
        groupedMessages.map((group) => (
          <div key={group.date} className="space-y-2">
            <div className="flex justify-center">
              <span className="text-xs text-slate-500 bg-slate-800/50 px-3 py-1 rounded-full">
                {group.date}
              </span>
            </div>
            
            {group.items.map((msg, index) => {
              const isSent = msg.sender_id === currentUserId;
              const showTime = index === group.items.length - 1 || 
                new Date(group.items[index + 1].timestamp).getTime() - new Date(msg.timestamp).getTime() > 60000;

              return (
                <div
                  key={msg.id}
                  className={`flex ${isSent ? 'justify-end' : 'justify-start'}`}
                >
                  <div className="max-w-[75%]">
                    <div className={isSent ? 'message-sent' : 'message-received'}>
                      <span style={{ whiteSpace: 'pre-wrap' }}>
                        {msg.decryptedContent || '[Decrypting...]'}
                      </span>
                    </div>
                    {showTime && (
                      <p className={`text-[10px] text-slate-500 mt-1 flex items-center gap-1 ${isSent ? 'justify-end' : 'justify-start'}`}>
                        {isSent && (
                          <span className="inline-flex relative text-slate-500">
                            <svg 
                              width="13" 
                              height="8" 
                              viewBox="0 0 16 9" 
                              fill="none"
                            >
                              <path 
                                d="M0.5 4.5L3.5 7.5L8.5 0.5" 
                                stroke="currentColor" 
                                strokeWidth="1.2" 
                                strokeLinecap="round" 
                                strokeLinejoin="round"
                              />
                              {msg.read && (
                                <path 
                                  d="M4.5 4.5L7.5 7.5L12.5 0.5" 
                                  stroke="currentColor" 
                                  strokeWidth="1.2" 
                                  strokeLinecap="round" 
                                  strokeLinejoin="round"
                                />
                              )}
                            </svg>
                          </span>
                        )}
                        {format(new Date(msg.timestamp), 'h:mm a')}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}

      {typing && (
        <div className="flex justify-start">
          <div className="message-received py-3">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
