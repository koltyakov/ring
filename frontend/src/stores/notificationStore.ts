import { create } from 'zustand';

export interface Notification {
  id: string
  senderId: number
  senderName: string
  message: string
  timestamp: Date
}

interface NotificationState {
  notifications: Notification[]
  showNotification: (notification: Omit<Notification, 'id' | 'timestamp'>) => void
  dismissNotification: (id: string) => void
  clearAllNotifications: () => void
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],

  showNotification: (notification) => {
    const { notifications } = get();
    
    // Check if there's already a notification from this sender
    const existingNotification = notifications.find((n) => n.senderId === notification.senderId);
    
    if (existingNotification) {
      // Same sender - don't add a new notification, just skip
      return;
    }
    
    // Different sender or no existing notification - clear all and show new one
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newNotification: Notification = {
      ...notification,
      id,
      timestamp: new Date(),
    };
    
    // Replace all existing notifications with the new one
    set({ notifications: [newNotification] });

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      get().dismissNotification(id);
    }, 5000);
  },

  dismissNotification: (id: string) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  clearAllNotifications: () => {
    set({ notifications: [] });
  },
}));
