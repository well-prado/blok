import { cn } from "@/lib/utils";
import { type Notification, useNotificationStore } from "@/stores/notifications";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

// SEMANTIC STATUS, so the prop is `tone`, not `variant` (§2.10). A toast has no
// emphasis ladder. `neutral` is omitted: a statusless toast has nothing to say.
const tones = {
	success: { Icon: CheckCircle2, glyph: "text-status-completed-ink" },
	error: { Icon: XCircle, glyph: "text-status-failed-ink" },
	warning: { Icon: AlertTriangle, glyph: "text-status-warning-ink" },
	info: { Icon: Info, glyph: "text-status-running-ink" },
} as const;

type ToastProps = Omit<React.ComponentPropsWithRef<"output">, "children" | "title"> & {
	tone?: keyof typeof tones;
	title: React.ReactNode;
	message?: React.ReactNode;
	/** Renders the title as a button. Used for "jump to the run this is about". */
	onSelect?: () => void;
	onDismiss?: () => void;
};

/**
 * One toast. Presentational — it owns no timers and no store.
 *
 * `<output>` rather than `<div role="status">`: same live-region role, native
 * element, no `biome-ignore lint/a11y/*`. The old `NotificationToast` put the
 * click handler on the container `<div role="presentation">` and carried a
 * suppression for it; here the clickable thing is a real `<button>`, so the
 * toast is keyboard-reachable and the suppression is gone.
 */
export function Toast({ className, tone = "info", title, message, onSelect, onDismiss, ...props }: ToastProps) {
	const { Icon, glyph } = tones[tone];
	return (
		<output
			className={cn(
				// §2.9 elevation: self-dismissing, does not block the page → `floating`.
				"flex w-full items-start gap-2 rounded-md border border-line bg-overlay p-3 shadow-lg",
				"animate-slide-in",
				className,
			)}
			{...props}
		>
			<Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", glyph)} />
			<div className="min-w-0 flex-1">
				{onSelect ? (
					<button
						type="button"
						onClick={onSelect}
						className="focus-ring block w-full truncate rounded-md text-left text-sm font-medium text-ink hover:text-ink-strong"
					>
						{title}
					</button>
				) : (
					<p className="truncate text-sm font-medium text-ink">{title}</p>
				)}
				{message && <p className="mt-0.5 truncate text-xs text-ink-dimmed">{message}</p>}
			</div>
			{onDismiss && (
				<button
					type="button"
					aria-label="Dismiss"
					onClick={onDismiss}
					className="focus-ring -mr-1 shrink-0 rounded-md p-1 text-ink-muted transition-colors hover:text-ink"
				>
					<X aria-hidden="true" className="h-3.5 w-3.5" />
				</button>
			)}
		</output>
	);
}

/**
 * The app-wide toast stack, folded in from `shared/NotificationToast.tsx` (§6).
 * The zustand store stays where it is; only the rendering moved. `NotificationBell`
 * stays in the old file, which now re-exports this.
 */
export function NotificationToast() {
	const { notifications } = useNotificationStore();
	const [visibleToasts, setVisibleToasts] = useState<Notification[]>([]);
	const navigate = useNavigate();

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

	const dismiss = (id: string) => setVisibleToasts((prev) => prev.filter((t) => t.id !== id));

	if (visibleToasts.length === 0) return null;

	return (
		<div className="fixed right-4 bottom-8 z-50 flex w-80 flex-col gap-2">
			{visibleToasts.map((toast) => {
				const { id, runId } = toast;
				return (
					<Toast
						key={id}
						tone={toast.type}
						title={toast.title}
						message={toast.message}
						onDismiss={() => dismiss(id)}
						onSelect={
							runId
								? () => {
										navigate({ to: "/runs/$runId", params: { runId } });
										dismiss(id);
									}
								: undefined
						}
					/>
				);
			})}
		</div>
	);
}
