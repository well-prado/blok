import { NotificationCard } from "@/components/layout/NotificationCard";
import { useNotificationStore } from "@/stores/notifications";
import * as Popover from "@radix-ui/react-popover";
import { Bell, CheckCheck, Trash2 } from "lucide-react";

export function NotificationPanel() {
	const notifications = useNotificationStore((s) => s.notifications);
	const markAllRead = useNotificationStore((s) => s.markAllRead);
	const clearAll = useNotificationStore((s) => s.clearAll);

	const unreadCount = notifications.filter((n) => !n.read).length;

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="w-full flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-hover transition-colors"
					aria-label="Notifications"
				>
					<div className="flex items-center gap-2">
						<Bell className="w-4 h-4" />
						Notifications
					</div>
					{unreadCount > 0 && (
						<span className="flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-blok-green-500 text-[10px] font-bold text-zinc-950">
							{unreadCount > 99 ? "99+" : unreadCount}
						</span>
					)}
				</button>
			</Popover.Trigger>

			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={8}
					className="z-50 w-80 rounded-md border border-zinc-800 bg-overlay shadow-xl overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
				>
					<div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
						<h3 className="font-semibold text-sm text-zinc-100">Notifications</h3>
						<div className="flex items-center gap-2">
							{unreadCount > 0 && (
								<button
									type="button"
									onClick={markAllRead}
									className="group flex items-center gap-1.5 rounded bg-transparent px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-hover hover:text-zinc-200"
								>
									<CheckCheck className="h-3.5 w-3.5" />
									<span>Mark all read</span>
								</button>
							)}
							{notifications.length > 0 && (
								<button
									type="button"
									onClick={clearAll}
									className="flex items-center justify-center rounded bg-transparent p-1 text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-500"
									aria-label="Clear all"
								>
									<Trash2 className="h-3.5 w-3.5" />
								</button>
							)}
						</div>
					</div>

					<div className="max-h-[28rem] overflow-y-auto p-2">
						{notifications.length === 0 ? (
							<div className="py-8 text-center text-sm text-zinc-500">No notifications</div>
						) : (
							<div className="space-y-1">
								{notifications.map((notification) => (
									<NotificationCard key={notification.id} notification={notification} />
								))}
							</div>
						)}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
