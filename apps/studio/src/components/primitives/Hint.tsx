import { cn } from "@/lib/utils";

/**
 * Helper text under a field. Give it an `id` and point the control's
 * `aria-describedby` at it — that association is the whole reason it exists as
 * a primitive rather than a bare `<p>`.
 */
export function Hint({ className, ...props }: React.ComponentPropsWithRef<"p">) {
	return <p className={cn("text-xs leading-snug text-ink-muted", className)} {...props} />;
}
