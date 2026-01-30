import { create } from "zustand";

export interface Notification {
  id: string;
  type: "success" | "error" | "info";
  title: string;
  message?: string;
  runId?: string;
  workflowName?: string;
  timestamp: number;
  read: boolean;
}

interface NotificationState {
  notifications: Notification[];
  enabled: boolean;
  desktopEnabled: boolean;
  addNotification: (n: Omit<Notification, "id" | "timestamp" | "read">) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  setEnabled: (enabled: boolean) => void;
  setDesktopEnabled: (enabled: boolean) => void;
}

let notifCounter = 0;

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  enabled: true,
  desktopEnabled: false,

  addNotification: (n) => {
    const notification: Notification = {
      ...n,
      id: `notif_${++notifCounter}`,
      timestamp: Date.now(),
      read: false,
    };

    set((s) => ({
      notifications: [notification, ...s.notifications].slice(0, 100),
    }));

    // Send desktop notification if enabled
    if (get().desktopEnabled && document.hidden) {
      try {
        new window.Notification(notification.title, {
          body: notification.message,
          icon: "/favicon.svg",
          tag: notification.runId || notification.id,
        });
      } catch {
        // Notifications not supported or blocked
      }
    }
  },

  markRead: (id) =>
    set((s) => ({
      notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    })),

  markAllRead: () =>
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
    })),

  clearAll: () => set({ notifications: [] }),

  setEnabled: (enabled) => set({ enabled }),

  setDesktopEnabled: (desktopEnabled) => set({ desktopEnabled }),
}));

/** Request desktop notification permission. Returns true if granted. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}
