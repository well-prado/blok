import { cn } from "@/lib/utils";
import { AlertCircle } from "lucide-react";

/**
 * Renders nothing when there is no error, so a caller can pass a possibly-empty
 * message without a conditional of its own.
 *
 * Give it an `id`, point the invalid control's `aria-describedby` at that id,
 * and set `aria-invalid` on the control (§9). The text uses the `-ink` status
 * role, never the fill (§3.1).
 */
export function FormError({ className, children, ...props }: React.ComponentPropsWithRef<"p">) {
	if (!children) return null;
	return (
		<p className={cn("flex items-start gap-1 text-xs leading-snug text-status-failed-ink", className)} {...props}>
			<AlertCircle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
			{children}
		</p>
	);
}
