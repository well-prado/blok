import { cn } from "@/lib/utils";

/**
 * `run_d1f7dca71dbe8f3a` → `run_d1f7…8f3a`. Both ends carry meaning in an id, so
 * a middle ellipsis beats CSS `truncate`, which always eats the end.
 *
 * ponytail: character-count truncation, not width measurement. The reference
 * measures a hidden span against the parent and binary-searches the split; that
 * needs a ResizeObserver, a layout effect and ~120 lines to handle a container
 * whose width Studio's id columns fix anyway. Swap in measurement if a caller
 * genuinely needs the ellipsis to track a fluid container.
 */
export function middleTruncate(text: string, maxLength: number): string {
	if (maxLength < 1 || text.length <= maxLength) return text;
	const keep = maxLength - 1; // one column goes to the ellipsis
	const start = Math.ceil(keep / 2);
	const end = keep - start;
	// `slice(-0)` returns the WHOLE string, so the zero case has to be explicit.
	return `${text.slice(0, start)}…${end > 0 ? text.slice(-end) : ""}`;
}

type MiddleTruncateProps = Omit<React.ComponentPropsWithRef<"span">, "children"> & {
	text: string;
	/** Total characters shown, ellipsis included. */
	maxLength?: number;
};

export function MiddleTruncate({ text, maxLength = 24, className, ...props }: MiddleTruncateProps) {
	return (
		<span className={cn("font-mono", className)} {...props}>
			<span aria-hidden="true">{middleTruncate(text, maxLength)}</span>
			{/* Screen readers get the whole id; sighted users get the ellipsis.
			    `select-none` is load-bearing, not cosmetic: without it BOTH strings are
			    selectable, so a mouse-select + Cmd+C over this element copies them
			    concatenated ("run_d1…a2c4erun_d1f7dca71dbe8f3a2c4e") — i.e. it ships a
			    corrupt id. `user-select: none` removes the node from Chrome's visual
			    selection without touching the accessibility tree, so screen readers
			    still read the full value. */}
			<span className="sr-only select-none">{text}</span>
		</span>
	);
}
