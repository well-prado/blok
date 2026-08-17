import { cn } from "@/lib/utils";

// The size ladder, verbatim from `_design/CONVENTIONS.md` §2.4.
const sizes = {
	xs: "h-6 px-2 text-xs",
	sm: "h-7 px-2.5 text-xs",
	md: "h-8 px-3 text-sm",
	lg: "h-9 px-4 text-sm",
} as const;

// `size` on a native input is a NUMBER (visible character width), so the prop
// has to be omitted before it can be re-declared as the ladder key.
type InputProps = Omit<React.ComponentPropsWithRef<"input">, "size"> & {
	size?: keyof typeof sizes;
};

/**
 * A bare styled `<input>` — no wrapper, so `.focus-ring` lands on the element
 * that actually receives focus (§2.7).
 *
 * Error state is driven off `aria-invalid`, not a prop: the a11y contract
 * already requires the caller to set it, so a second source of truth would only
 * let the two disagree. Pair it with `aria-describedby` pointing at a
 * `<FormError>`.
 */
export function Input({ className, size = "md", ...props }: InputProps) {
	return (
		<input
			className={cn(
				// NOT `transition-colors`: its property list includes `outline-color`,
				// which pins the outline to `currentcolor` FOREVER (the transition from
				// the keyword never resolves) and silently repaints `.focus-ring` in
				// `text-ink` instead of the focus-ring token. Measured in Chrome.
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
