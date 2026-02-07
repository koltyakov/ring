import { create } from 'zustand';
import api, { type User } from '../utils/api';
import { getOrCreateKeys, getPublicKeyBase64 } from '../utils/crypto';

interface AuthState {
  token: string | null
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  register: (username: string, password: string, inviteCode: string) => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  checkAuth: () => void
  clearError: () => void
  createInvite: () => Promise<string>
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('token'),
  user: null,
  isAuthenticated: !!localStorage.getItem('token'),
  isLoading: false,
  error: null,

  register: async (username: string, password: string, inviteCode: string) => {
    set({ isLoading: true, error: null });
    try {
      // Generate keys (or use existing)
      await getOrCreateKeys(); // This stores keys in localStorage
      const publicKeyBase64 = getPublicKeyBase64();
      
      if (!publicKeyBase64) {
        throw new Error('Failed to generate encryption keys');
      }

      const response = await api.register(username, password, inviteCode, publicKeyBase64);
      
      localStorage.setItem('token', response.token);
      set({
        token: response.token,
        user: response.user,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
      });
      throw error;
    }
  },

  login: async (username: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      // Generate/validate keys BEFORE login
      console.log('[Auth] Ensuring encryption keys exist before login...');
      await getOrCreateKeys();
      const publicKeyBase64 = getPublicKeyBase64();
      
      if (!publicKeyBase64) {
        throw new Error('Failed to get encryption keys');
      }
      
      console.log('[Auth] Keys ready, logging in...');
      const response = await api.login(username, password);
      
      localStorage.setItem('token', response.token);
      
      // Immediately sync the public key after login
      console.log('[Auth] Login successful, syncing public key...');
      try {
        await api.updatePublicKey(publicKeyBase64);
        console.log('[Auth] Public key synced successfully');
      } catch (error) {
        console.error('[Auth] Failed to sync public key on login:', error);
        // Continue anyway - checkAuth will try again
      }
      
      set({
        token: response.token,
        user: { ...response.user, public_key: publicKeyBase64 },
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
      });
      throw error;
    }
  },

  logout: () => {
    localStorage.removeItem('token');
    set({
      token: null,
      user: null,
      isAuthenticated: false,
    });
  },

  checkAuth: async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      set({ isAuthenticated: false, user: null });
      return;
    }

    try {
      const user = await api.getMe();
      
      // Check if local public key matches server
      await getOrCreateKeys(); // Ensure keys exist
      const localPublicKey = getPublicKeyBase64();
      
      if (localPublicKey && localPublicKey !== user.public_key) {
        console.log('[Auth] Local public key differs from server, syncing...');
        try {
          await api.updatePublicKey(localPublicKey);
          console.log('[Auth] Public key synced successfully');
          user.public_key = localPublicKey;
        } catch (error) {
          console.error('[Auth] Failed to sync public key:', error);
        }
      }
      
      set({ user, isAuthenticated: true, error: null });
    } catch {
      localStorage.removeItem('token');
      set({ isAuthenticated: false, user: null, error: null });
    }
  },

  createInvite: async () => {
    const response = await api.createInvite();
    return response.code;
  },

  clearError: () => set({ error: null }),
}));
