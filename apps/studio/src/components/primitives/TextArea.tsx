import { cn } from "@/lib/utils";

/**
 * §2.4 says a multi-line box "sets `min-h-*` from the row height and keeps the
 * row's padding-x and text size". The ladder has no padding-Y column, so the
 * `py-*` here is DERIVED: it is the value that makes one line of the row's text
 * add up to the row's height (md: 6 + 20 + 6 = 32 = `h-8`). Reported as a gap
 * rather than invented as a new ladder row.
 */
const sizes = {
	xs: "min-h-6 px-2 py-1 text-xs",
	sm: "min-h-7 px-2.5 py-1.5 text-xs",
	md: "min-h-8 px-3 py-1.5 text-sm",
	lg: "min-h-9 px-4 py-2 text-sm",
} as const;

type TextAreaProps = React.ComponentPropsWithRef<"textarea"> & {
	size?: keyof typeof sizes;
};

export function TextArea({ className, size = "md", rows = 4, ...props }: TextAreaProps) {
	return (
		<textarea
			rows={rows}
			className={cn(
				// See Input.tsx: `transition-colors` would pin `outline-color` to
				// `currentcolor` and repaint `.focus-ring` in the wrong colour.
				"focus-ring w-full rounded-md border border-line-strong bg-control text-ink",
				"transition-[background-color]",
				"placeholder:text-ink-muted hover:border-line-bright",
				"aria-[invalid=true]:border-status-failed",
				"disabled:pointer-events-none disabled:opacity-50",
				sizes[size],
				className,
			)}
			{...props}
		/>
	);
}
