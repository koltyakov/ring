import { useNavigate } from 'react-router-dom'
import { useUsersStore } from '../stores/usersStore'

interface ChatHeaderProps {
  userId: number
}

export default function ChatHeader({ userId }: ChatHeaderProps) {
  const navigate = useNavigate()
  const user = useUsersStore(state => state.getUserById(userId))

  if (!user) return null

  return (
    <div className="glass border-b border-slate-800 px-4 py-3 flex items-center gap-3 pt-safe">
      <button
        onClick={() => navigate('/')}
        className="p-2 -ml-2 rounded-full hover:bg-slate-800 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <div className="relative">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-white font-semibold">
          {user.username[0].toUpperCase()}
        </div>
        {user.online && (
          <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-slate-900" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <h2 className="font-semibold text-white truncate">{user.username}</h2>
        <p className="text-xs text-slate-400">
          {user.online ? 'Online' : 'Offline'}
        </p>
      </div>

      <button
        onClick={() => navigate(`/call/${userId}`)}
        className="p-2 rounded-full hover:bg-slate-800 transition-colors text-primary-500"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
        </svg>
      </button>
    </div>
  )
}
