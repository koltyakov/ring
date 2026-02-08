import { create } from 'zustand';
import api, { type Message } from '../utils/api';
import { encryptMessage, decryptMessage, base64ToBytes } from '../utils/crypto';
import { useUsersStore } from './usersStore';

interface DecryptedMessage extends Message {
  decryptedContent?: string
}

interface MessagesState {
  messages: Map<number, DecryptedMessage[]>
  isLoading: boolean
  typingUsers: Map<number, boolean>
  unreadCounts: Map<number, number>
  activeChatUserId: number | null
  fetchMessages: (userId: number) => Promise<void>
  sendMessage: (receiverId: number, content: string) => Promise<void>
  addMessage: (message: Message) => void
  setTyping: (userId: number, typing: boolean) => void
  markMessagesAsRead: (userId: number) => void
  clearMessages: (userId: number) => Promise<void>
  clearMessagesLocal: (userId: number) => void
  getMessagesForUser: (userId: number) => DecryptedMessage[]
  getUnreadCount: (userId: number) => number
  getTotalUnreadCount: () => number
  setActiveChatUserId: (userId: number | null) => void
  incrementUnreadCount: (userId: number) => void
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messages: new Map(),
  isLoading: false,
  typingUsers: new Map(),
  unreadCounts: new Map(),
  activeChatUserId: null,

  fetchMessages: async (userId: number) => {
    set({ isLoading: true });
    try {
      const messages = await api.getMessages(userId);
      
      // Decrypt messages
      const user = useUsersStore.getState().getUserById(userId);
      if (!user) {
        set({ isLoading: false });
        return;
      }

      const decryptedMessages = await Promise.all(
        messages.map(async (msg) => {
          try {
            const decryptedContent = await decryptMessage(
              { content: msg.content, nonce: msg.nonce },
              base64ToBytes(user.public_key)
            );
            return { ...msg, decryptedContent };
          } catch {
            return { ...msg, decryptedContent: '[Unable to decrypt]' };
          }
        })
      );

      set((state) => {
        const newMessages = new Map(state.messages);
        newMessages.set(userId, decryptedMessages.reverse());
        return { messages: newMessages, isLoading: false };
      });
    } catch (error) {
      console.error('Failed to fetch messages:', error);
      set({ isLoading: false });
    }
  },

  sendMessage: async (receiverId: number, content: string) => {
    const user = useUsersStore.getState().getUserById(receiverId);
    if (!user) {
      console.error('[Messages] User not found:', receiverId);
      throw new Error('Recipient not found');
    }

    console.log('[Messages] Sending message to user:', user.username, 'public_key length:', user.public_key?.length);

    try {
      const encrypted = await encryptMessage(content, base64ToBytes(user.public_key));
      console.log('[Messages] Message encrypted successfully');
      
      const message = await api.sendMessage(receiverId, encrypted.content, encrypted.nonce);
      console.log('[Messages] Message sent to server');
      
      // Add to local state
      set((state) => {
        const newMessages = new Map(state.messages);
        const userMessages = newMessages.get(receiverId) || [];
        newMessages.set(receiverId, [...userMessages, { ...message, decryptedContent: content }]);
        return { messages: newMessages };
      });
    } catch (error) {
      console.error('[Messages] Failed to send message:', error);
      throw error;
    }
  },

  addMessage: async (message: Message) => {
    console.log('[Messages] Received message via WebSocket:', message);
    
    // Determine the other user
    const token = localStorage.getItem('token');
    const currentUserId = token ? JSON.parse(atob(token.split('.')[1])).user_id : 0;
    const otherUserId = message.sender_id === currentUserId ? message.receiver_id : message.sender_id;

    console.log('[Messages] Current user:', currentUserId, 'Other user:', otherUserId, 'Sender:', message.sender_id);

    // Get the sender's public key
    const sender = message.sender_id === currentUserId 
      ? null 
      : useUsersStore.getState().getUserById(message.sender_id);

    let decryptedContent: string | undefined;
    if (sender) {
      console.log('[Messages] Decrypting message from:', sender.username);
      try {
        decryptedContent = await decryptMessage(
          { content: message.content, nonce: message.nonce },
          base64ToBytes(sender.public_key)
        );
        console.log('[Messages] Message decrypted successfully');
      } catch (error) {
        console.error('[Messages] Decryption failed:', error);
        decryptedContent = '[Unable to decrypt]';
      }
    } else {
      console.log('[Messages] Message from self, not decrypting');
      decryptedContent = undefined;
    }

    set((state) => {
      const newMessages = new Map(state.messages);
      const userMessages = newMessages.get(otherUserId) || [];
      newMessages.set(otherUserId, [...userMessages, { ...message, decryptedContent }]);
      
      // Increment unread count if message is from someone else and chat is not active
      const newUnreadCounts = new Map(state.unreadCounts);
      if (message.sender_id !== currentUserId && state.activeChatUserId !== otherUserId) {
        const currentCount = newUnreadCounts.get(otherUserId) || 0;
        newUnreadCounts.set(otherUserId, currentCount + 1);
      }
      
      console.log('[Messages] Added message to store for user:', otherUserId, 'Total messages:', userMessages.length + 1);
      return { messages: newMessages, unreadCounts: newUnreadCounts };
    });
  },

  setTyping: (userId: number, typing: boolean) => {
    set((state) => {
      const newTyping = new Map(state.typingUsers);
      newTyping.set(userId, typing);
      return { typingUsers: newTyping };
    });
  },

  markMessagesAsRead: (userId: number) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      const userMessages = newMessages.get(userId);
      if (userMessages) {
        const updatedMessages = userMessages.map(msg => ({ ...msg, read: true }));
        newMessages.set(userId, updatedMessages);
      }
      // Clear unread count for this user
      const newUnreadCounts = new Map(state.unreadCounts);
      newUnreadCounts.delete(userId);
      return { messages: newMessages, unreadCounts: newUnreadCounts };
    });
  },

  getMessagesForUser: (userId: number) => {
    return get().messages.get(userId) || [];
  },

  getUnreadCount: (userId: number) => {
    return get().unreadCounts.get(userId) || 0;
  },

  getTotalUnreadCount: () => {
    let total = 0;
    get().unreadCounts.forEach((count) => {
      total += count;
    });
    return total;
  },

  setActiveChatUserId: (userId: number | null) => {
    set((state) => {
      // When setting a new active chat, clear its unread count
      const newUnreadCounts = new Map(state.unreadCounts);
      if (userId !== null) {
        newUnreadCounts.delete(userId);
      }
      return { activeChatUserId: userId, unreadCounts: newUnreadCounts };
    });
  },

  incrementUnreadCount: (userId: number) => {
    set((state) => {
      const newUnreadCounts = new Map(state.unreadCounts);
      const currentCount = newUnreadCounts.get(userId) || 0;
      newUnreadCounts.set(userId, currentCount + 1);
      return { unreadCounts: newUnreadCounts };
    });
  },

  clearMessages: async (userId: number) => {
    try {
      await api.clearMessages(userId);
      // Clear local messages
      set((state) => {
        const newMessages = new Map(state.messages);
        newMessages.set(userId, []);
        return { messages: newMessages };
      });
    } catch (error) {
      console.error('Failed to clear messages:', error);
      throw error;
    }
  },

  clearMessagesLocal: (userId: number) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      newMessages.set(userId, []);
      return { messages: newMessages };
    });
  },
}));
