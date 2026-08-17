import { cn } from "@/lib/utils";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

/**
 * The reference splits this role across three files — `Callout.tsx` (inline
 * banner), `Alert.tsx` (dismissible) and `InfoPanel.tsx` (titled panel). They
 * differ only by "has a title" and "has a dismiss button", so this is one
 * component with two optional props. See the PR notes for the ticket delta.
 */
const variants = {
	info: { box: "border-status-running/30 bg-status-running/10", glyph: "text-status-running-ink", Icon: Info },
	success: {
		box: "border-status-completed/30 bg-status-completed/10",
		glyph: "text-status-completed-ink",
		Icon: CheckCircle2,
	},
	warning: {
		box: "border-status-warning/30 bg-status-warning/10",
		glyph: "text-status-warning-ink",
		Icon: AlertTriangle,
	},
	error: { box: "border-status-failed/30 bg-status-failed/10", glyph: "text-status-failed-ink", Icon: AlertCircle },
	neutral: { box: "border-line bg-raised", glyph: "text-ink-muted", Icon: Info },
} as const;

type CalloutProps = Omit<React.ComponentPropsWithRef<"div">, "title"> & {
	variant?: keyof typeof variants;
	/** Optional heading above the body. */
	title?: React.ReactNode;
	/** Replaces the variant's default glyph. Pass your own `aria-hidden` icon. */
	icon?: React.ReactNode;
	/** When given, renders a dismiss button. Owning the open state is the caller's job. */
	onDismiss?: () => void;
};

export function Callout({ className, variant = "info", title, icon, onDismiss, children, ...props }: CalloutProps) {
	const { box, glyph, Icon } = variants[variant];
	return (
		<div className={cn("flex w-full items-start gap-2.5 rounded-md border p-3", box, className)} {...props}>
			{icon ?? <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", glyph)} />}
			<div className="min-w-0 flex-1">
				{title && <p className="text-sm font-medium text-ink-strong">{title}</p>}
				<div className={cn("text-sm text-ink-dimmed", title && "mt-1")}>{children}</div>
			</div>
			{onDismiss && (
				<button
					type="button"
					aria-label="Dismiss"
					onClick={onDismiss}
					className="focus-ring -mr-1 shrink-0 rounded-md p-1 text-ink-muted transition-colors hover:text-ink"
				>
					<X aria-hidden="true" className="h-4 w-4" />
				</button>
			)}
		</div>
	);
}
