import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

// Ladder §2.4. The right padding is the row's padding-x plus room for the
// chevron, which is drawn by us because `appearance-none` removes the native one.
const sizes = {
	xs: { select: "h-6 pl-2 pr-6 text-xs", chevron: "h-3 w-3 right-2" },
	sm: { select: "h-7 pl-2.5 pr-7 text-xs", chevron: "h-3.5 w-3.5 right-2" },
	md: { select: "h-8 pl-3 pr-8 text-sm", chevron: "h-4 w-4 right-2.5" },
	lg: { select: "h-9 pl-4 pr-9 text-sm", chevron: "h-5 w-5 right-3" },
} as const;

type SelectProps = Omit<React.ComponentPropsWithRef<"select">, "size"> & {
	size?: keyof typeof sizes;
	containerClassName?: string;
};

/**
 * A REAL `<select>`. Radix's select is 352 KB and is not installed (§4.2); the
 * native element brings typeahead, keyboard operation and the platform's own
 * option list — including the mobile wheel — for nothing.
 *
 * `<option>` children are passed through untouched, so the caller keeps
 * `optgroup`, `disabled` options and `defaultValue`.
 */
export function Select({ className, containerClassName, size = "md", children, ...props }: SelectProps) {
	const { select, chevron } = sizes[size];
	return (
		<div className={cn("relative inline-flex w-full items-center", containerClassName)}>
			<select
				className={cn(
					// See Input.tsx: `transition-colors` would pin `outline-color` to
					// `currentcolor` and repaint `.focus-ring` in the wrong colour.
					"focus-ring w-full appearance-none rounded-md border border-line-strong bg-control text-ink",
					"transition-[background-color]",
					"hover:border-line-bright",
					"aria-[invalid=true]:border-status-failed",
					"disabled:pointer-events-none disabled:opacity-50",
					select,
					className,
				)}
				{...props}
			>
				{children}
			</select>
			<ChevronDown aria-hidden="true" className={cn("pointer-events-none absolute text-ink-muted", chevron)} />
		</div>
	);
}
