import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

/**
 * The exemplar primitive. Copy its shape, not just its code:
 *
 *   - a plain `variants` / `sizes` object typed `as const` (no cva, no shared
 *     variant helper — see `_design/CONVENTIONS.md` §2)
 *   - props extend the native element via `ComponentPropsWithRef` (React 19,
 *     so `ref` is a plain prop and `forwardRef` is not used)
 *   - `className` is the LAST argument to `cn()`, so callers can override
 *   - decorative glyph is `aria-hidden`; the accessible name is the `label`
 *
 * Deliberately a primitive no E1 task owns, so nobody collides with it while
 * still having a loading indicator to reach for.
 */
const sizes = {
	sm: "h-3 w-3",
	md: "h-4 w-4",
	lg: "h-6 w-6",
} as const;

const tones = {
	default: "text-ink-muted",
	accent: "text-accent",
	inherit: "text-current",
} as const;

type SpinnerProps = Omit<React.ComponentPropsWithRef<"output">, "children"> & {
	size?: keyof typeof sizes;
	tone?: keyof typeof tones;
	/** Accessible name. Pass `null` when an adjacent visible label already says it. */
	label?: string | null;
};

// `<output>` rather than `<span role="status">`: same role, native element, and
// it is what keeps this file free of a `biome-ignore lint/a11y/*` suppression.
export function Spinner({ className, size = "md", tone = "default", label = "Loading", ...props }: SpinnerProps) {
	return (
		<output className={cn("inline-flex items-center", tones[tone], className)} {...props}>
			<Loader2 aria-hidden="true" className={cn("animate-spin", sizes[size])} />
			{label !== null && <span className="sr-only">{label}</span>}
		</output>
	);
}
