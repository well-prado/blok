import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { requestNotificationPermission, useNotificationStore } from "@/stores/notifications";
import { useNavigate } from "@tanstack/react-router";
import { Bell, BellOff } from "lucide-react";
import { useState } from "react";

// The toast rendering moved to the design-system primitive (CONVENTIONS §6);
// `NotificationBell` is not superseded, so it stays here in full.
export { NotificationToast } from "@/components/primitives/Toast";

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
				type="button"
				onClick={() => setOpen(!open)}
				className="relative flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors"
				aria-label="Notifications"
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
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop overlay does not need keyboard interaction */}
					<div className="fixed inset-0 z-40" role="presentation" onClick={() => setOpen(false)} />
					<div className="absolute bottom-6 right-0 z-50 w-72 bg-overlay border border-zinc-800 rounded-lg shadow-xl">
						{/* Header */}
						<div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
							<span className="text-xs font-medium text-zinc-300">Notifications</span>
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={() => setEnabled(!enabled)}
									className="text-xs text-zinc-500 hover:text-zinc-300"
									title={enabled ? "Mute notifications" : "Enable notifications"}
								>
									{enabled ? <Bell className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
								</button>
								<button
									type="button"
									onClick={handleToggleDesktop}
									className={cn(
										"text-[10px] px-1.5 py-0.5 rounded",
										desktopEnabled ? "bg-blue-500/20 text-blue-400" : "bg-zinc-800 text-zinc-500 hover:text-zinc-300",
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
										type="button"
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
											{!n.read && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />}
											<span className="text-xs text-zinc-300 truncate">{n.title}</span>
											<span className="text-[10px] text-zinc-600 ml-auto shrink-0">
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
								<button type="button" onClick={markAllRead} className="text-[10px] text-zinc-500 hover:text-zinc-300">
									Mark all read
								</button>
								<button type="button" onClick={clearAll} className="text-[10px] text-zinc-500 hover:text-zinc-300">
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
