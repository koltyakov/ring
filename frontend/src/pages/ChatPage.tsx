import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useWebSocketStore } from '../stores/websocketStore';
import { useMessagesStore } from '../stores/messagesStore';
import UserList from '../components/UserList';
import ChatHeader from '../components/ChatHeader';
import MessageList from '../components/MessageList';
import MessageInput from '../components/MessageInput';
import ProfilePage from './ProfilePage';

export default function ChatPage() {
  const { userId } = useParams<{ userId?: string }>();
  const [activeTab, setActiveTab] = useState<'chats' | 'profile'>('chats');
  const isConnected = useWebSocketStore(state => state.isConnected);
  const setActiveChatUserId = useMessagesStore(state => state.setActiveChatUserId);
  const markMessagesAsRead = useMessagesStore(state => state.markMessagesAsRead);
  const totalUnreadCount = useMessagesStore(state => state.getTotalUnreadCount)();
  
  // Track active chat and mark messages as read
  useEffect(() => {
    if (userId) {
      const selectedUserId = parseInt(userId, 10);
      setActiveChatUserId(selectedUserId);
      markMessagesAsRead(selectedUserId);
    } else {
      setActiveChatUserId(null);
    }
    
    return () => {
      setActiveChatUserId(null);
    };
  }, [userId, setActiveChatUserId, markMessagesAsRead]);

  if (!userId) {
    return (
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="glass border-b border-slate-800 px-4 py-4 pt-safe">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-white">Messages</h1>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className={`text-sm ${isConnected ? 'text-slate-400' : 'text-red-400'}`}>
                {isConnected ? 'Connected' : 'Offline'}
              </span>
            </div>
          </div>
        </div>

        {activeTab === 'chats' ? <UserList /> : <ProfilePage />}

        {/* Bottom nav for mobile-like feel */}
        <div className="glass border-t border-slate-800 px-4 py-3 pb-safe">
          <div className="flex justify-around">
            <button 
              onClick={() => setActiveTab('chats')}
              className={`flex flex-col items-center gap-1 relative ${activeTab === 'chats' ? 'text-primary-500' : 'text-slate-500'}`}
            >
              <div className="relative">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                {totalUnreadCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
                  </span>
                )}
              </div>
              <span className="text-xs">Chats</span>
            </button>
            <button 
              onClick={() => setActiveTab('profile')}
              className={`flex flex-col items-center gap-1 ${activeTab === 'profile' ? 'text-primary-500' : 'text-slate-500'}`}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span className="text-xs">Profile</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const selectedUserId = parseInt(userId, 10);

  return (
    <div className="flex-1 flex flex-col min-h-0 mobile-full sm:static">
      <ChatHeader userId={selectedUserId} />
      <MessageList userId={selectedUserId} />
      <MessageInput userId={selectedUserId} />
    </div>
  );
}
