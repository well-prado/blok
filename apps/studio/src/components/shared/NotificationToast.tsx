import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { X, CheckCircle2, XCircle, Info, Bell, BellOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useNotificationStore,
  requestNotificationPermission,
  type Notification,
} from "@/stores/notifications";
import { formatRelativeTime } from "@/lib/formatters";

/** Toast popup for recent notifications. */
export function NotificationToast() {
  const { notifications } = useNotificationStore();
  const [visibleToasts, setVisibleToasts] = useState<Notification[]>([]);

  // Show new unread notifications as toasts
  useEffect(() => {
    const latest = notifications[0];
    if (!latest || latest.read) return;
    // Only show if it arrived in the last 5 seconds
    if (Date.now() - latest.timestamp > 5000) return;

    setVisibleToasts((prev) => {
      if (prev.some((t) => t.id === latest.id)) return prev;
      return [latest, ...prev].slice(0, 3);
    });

    // Auto-dismiss after 5 seconds
    const timer = setTimeout(() => {
      setVisibleToasts((prev) => prev.filter((t) => t.id !== latest.id));
    }, 5000);

    return () => clearTimeout(timer);
  }, [notifications]);

  const dismissToast = (id: string) => {
    setVisibleToasts((prev) => prev.filter((t) => t.id !== id));
  };

  if (visibleToasts.length === 0) return null;

  return (
    <div className="fixed bottom-8 right-4 z-50 flex flex-col gap-2 w-80">
      {visibleToasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Notification; onDismiss: (id: string) => void }) {
  const navigate = useNavigate();

  const icons = {
    success: <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />,
    error: <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />,
    info: <Info className="w-4 h-4 text-blue-400 flex-shrink-0" />,
  };

  return (
    <div
      className={cn(
        "bg-zinc-900 border border-zinc-700 rounded-lg shadow-lg p-3",
        "animate-slide-in cursor-pointer hover:bg-zinc-800/80 transition-colors",
      )}
      onClick={() => {
        if (toast.runId) {
          navigate({ to: "/runs/$runId", params: { runId: toast.runId } });
        }
        onDismiss(toast.id);
      }}
    >
      <div className="flex items-start gap-2">
        {icons[toast.type]}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-200 truncate">{toast.title}</p>
          {toast.message && (
            <p className="text-xs text-zinc-400 mt-0.5 truncate">{toast.message}</p>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(toast.id);
          }}
          className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

/** Notification bell button for the status bar. */
export function NotificationBell() {
  const { notifications, enabled, desktopEnabled, setEnabled, setDesktopEnabled, markAllRead, clearAll } =
    useNotificationStore();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleToggleDesktop = async () => {
    if (!desktopEnabled) {
      const granted = await requestNotificationPermission();
      setDesktopEnabled(granted);
    } else {
      setDesktopEnabled(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <Bell className="w-3 h-3" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full text-[8px] text-white flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-6 right-0 z-50 w-72 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
              <span className="text-xs font-medium text-zinc-300">Notifications</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEnabled(!enabled)}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                  title={enabled ? "Mute notifications" : "Enable notifications"}
                >
                  {enabled ? <Bell className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
                </button>
                <button
                  onClick={handleToggleDesktop}
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded",
                    desktopEnabled
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-zinc-800 text-zinc-500 hover:text-zinc-300",
                  )}
                >
                  Desktop {desktopEnabled ? "ON" : "OFF"}
                </button>
              </div>
            </div>

            {/* Notifications list */}
            <div className="max-h-64 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-zinc-600">No notifications</div>
              ) : (
                notifications.slice(0, 20).map((n) => (
                  <button
                    key={n.id}
                    onClick={() => {
                      if (n.runId) {
                        navigate({ to: "/runs/$runId", params: { runId: n.runId } });
                        setOpen(false);
                      }
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 hover:bg-zinc-800/50 transition-colors border-b border-zinc-800/50",
                      !n.read && "bg-zinc-800/30",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />}
                      <span className="text-xs text-zinc-300 truncate">{n.title}</span>
                      <span className="text-[10px] text-zinc-600 ml-auto flex-shrink-0">
                        {formatRelativeTime(n.timestamp)}
                      </span>
                    </div>
                    {n.message && <p className="text-[10px] text-zinc-500 mt-0.5 truncate">{n.message}</p>}
                  </button>
                ))
              )}
            </div>

            {/* Footer */}
            {notifications.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 border-t border-zinc-800">
                <button onClick={markAllRead} className="text-[10px] text-zinc-500 hover:text-zinc-300">
                  Mark all read
                </button>
                <button onClick={clearAll} className="text-[10px] text-zinc-500 hover:text-zinc-300">
                  Clear all
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
