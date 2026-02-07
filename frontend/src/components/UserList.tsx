import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUsersStore } from '../stores/usersStore';
import { formatDistanceToNow } from 'date-fns';

export default function UserList() {
  const navigate = useNavigate();
  const { users, isLoading, fetchUsers } = useUsersStore();
  const [_showInvite, _setShowInvite] = useState(false);

  useEffect(() => {
    // Poll for user updates every 30 seconds
    const interval = setInterval(fetchUsers, 30000);
    return () => clearInterval(interval);
  }, [fetchUsers]);

  if (isLoading && users.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-hide">
      {users.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center">
          <svg className="w-16 h-16 mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          <p className="text-lg font-medium mb-2">No users yet</p>
          <p className="text-sm">Invite friends to start chatting securely</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-800">
          {users.map(user => (
            <button
              key={user.id}
              onClick={() => navigate(`/chat/${user.id}`)}
              className="w-full flex items-center gap-3 p-4 hover:bg-slate-800/50 transition-colors text-left"
            >
              <div className="relative">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-white font-semibold text-lg">
                  {user.username[0].toUpperCase()}
                </div>
                {user.online && (
                  <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-green-500 rounded-full border-2 border-slate-950" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-white truncate">{user.username}</h3>
                <p className="text-sm text-slate-400">
                  {user.online 
                    ? 'Online' 
                    : user.last_seen 
                      ? `Last seen ${formatDistanceToNow(new Date(user.last_seen), { addSuffix: true })}`
                      : 'Offline'
                  }
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
