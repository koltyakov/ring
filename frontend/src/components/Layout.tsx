import { useEffect } from 'react'
import { useUsersStore } from '../stores/usersStore'
import { useWebSocketStore } from '../stores/websocketStore'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const fetchUsers = useUsersStore(state => state.fetchUsers)
  const connect = useWebSocketStore(state => state.connect)
  const disconnect = useWebSocketStore(state => state.disconnect)
  const isConnected = useWebSocketStore(state => state.isConnected)

  // Load users first, then connect WebSocket so presence updates have targets
  useEffect(() => {
    fetchUsers().then(() => connect())

    return () => {
      disconnect()
    }
  }, [fetchUsers, connect, disconnect])

  // Periodic refetch as a fallback to keep online status in sync
  useEffect(() => {
    if (!isConnected) return
    
    const interval = setInterval(() => {
      fetchUsers()
    }, 30000)
    
    return () => clearInterval(interval)
  }, [isConnected, fetchUsers])

  return (
    <div className="h-full flex flex-col bg-slate-950">
      {children}
    </div>
  )
}
