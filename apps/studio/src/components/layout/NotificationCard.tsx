import { formatTimeAgo } from "@/lib/dateUtils";
import { cn } from "@/lib/utils";
import { type Notification, useNotificationStore } from "@/stores/notifications";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";

interface NotificationCardProps {
	notification: Notification;
}

export function NotificationCard({ notification }: NotificationCardProps) {
	const markRead = useNotificationStore((s) => s.markRead);

	const Icon = notification.type === "success" ? CheckCircle2 : notification.type === "error" ? XCircle : Info;

	const iconColor =
		notification.type === "success"
			? "text-blok-green-500"
			: notification.type === "error"
				? "text-red-500"
				: "text-blue-500";

	return (
		<div
			className={cn(
				"group relative flex items-start gap-3 rounded-md p-3 text-sm transition-colors",
				notification.read ? "bg-transparent hover:bg-hover" : "bg-raised hover:bg-hover",
			)}
			onClick={() => !notification.read && markRead(notification.id)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					!notification.read && markRead(notification.id);
				}
			}}
			// biome-ignore lint/a11y/useSemanticElements: Card needs to be a div due to complex inner layout
			role="button"
			tabIndex={0}
		>
			<Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconColor)} />
			<div className="flex-1 space-y-1">
				<div className="flex items-center justify-between gap-2">
					<p className={cn("font-medium", notification.read ? "text-zinc-300" : "text-zinc-100")}>
						{notification.title}
					</p>
					<span className="shrink-0 text-[10px] text-zinc-500">{formatTimeAgo(notification.timestamp)}</span>
				</div>
				{notification.message && (
					<p className={cn("text-xs leading-relaxed", notification.read ? "text-zinc-500" : "text-zinc-400")}>
						{notification.message}
					</p>
				)}
				{(notification.workflowName || notification.runId) && (
					<div className="flex items-center gap-2 pt-1">
						{notification.workflowName && (
							<span className="rounded bg-zinc-800/50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
								{notification.workflowName}
							</span>
						)}
						{notification.runId && (
							<span className="text-[10px] font-mono text-zinc-500">{notification.runId.slice(0, 8)}</span>
						)}
					</div>
				)}
			</div>
			{!notification.read && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						markRead(notification.id);
					}}
					className="absolute right-2 top-2 rounded-sm opacity-0 transition-opacity hover:bg-zinc-700 group-hover:opacity-100 focus:opacity-100"
					aria-label="Mark as read"
				>
					<X className="h-4 w-4 text-zinc-400 hover:text-zinc-200" />
				</button>
			)}
		</div>
	);
}
