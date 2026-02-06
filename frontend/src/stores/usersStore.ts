import { create } from 'zustand'
import api, { type User } from '../utils/api'

interface UsersState {
  users: User[]
  isLoading: boolean
  fetchUsers: () => Promise<void>
  updateUserStatus: (userId: number, online: boolean) => void
  getUserById: (userId: number) => User | undefined
}

// Queue presence updates that arrive before users are loaded
const _pendingPresence = new Map<number, boolean>()

export const useUsersStore = create<UsersState>((set, get) => ({
  users: [],
  isLoading: false,

  fetchUsers: async () => {
    set({ isLoading: true })
    try {
      const users = await api.getUsers()
      // Filter out current user
      const token = localStorage.getItem('token')
      const currentUserId = token ? JSON.parse(atob(token.split('.')[1])).user_id : 0
      const filteredUsers = users.filter(u => u.id !== currentUserId)
      
      // Apply any queued presence updates that arrived before users loaded
      if (_pendingPresence.size > 0) {
        for (const user of filteredUsers) {
          const pending = _pendingPresence.get(user.id)
          if (pending !== undefined) {
            user.online = pending
          }
        }
        _pendingPresence.clear()
      }

      set({ users: filteredUsers, isLoading: false })
    } catch (error) {
      console.error('Failed to fetch users:', error)
      set({ isLoading: false })
    }
  },

  updateUserStatus: (userId: number, online: boolean) => {
    set((state) => {
      const userExists = state.users.some(u => u.id === userId)
      if (!userExists) {
        // Users not loaded yet — queue for when fetchUsers completes
        _pendingPresence.set(userId, online)
        return state
      }
      return {
        users: state.users.map(u =>
          u.id === userId ? { ...u, online } : u
        )
      }
    })
  },

  getUserById: (userId: number) => {
    return get().users.find(u => u.id === userId)
  },
}))
