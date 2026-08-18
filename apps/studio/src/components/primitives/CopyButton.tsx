import { cn } from "@/lib/utils";
import { Check, Copy, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyState = "idle" | "copied" | "error";

const ANNOUNCEMENTS: Record<CopyState, string> = {
	idle: "",
	copied: "Copied to clipboard",
	error: "Copy failed — select the value and copy it manually",
};

/**
 * The copy state machine: idle → copied|error → idle.
 *
 * `navigator.clipboard` does not exist in an insecure context (plain http on a
 * LAN IP, which is how Studio is often reached) and does not exist in jsdom, so
 * the absence is a normal branch, not an exception: it lands in `error`, which
 * every consumer renders as a visible + announced "copy it manually" state.
 *
 * ponytail: no `document.execCommand("copy")` fallback — it is explicitly out of
 * scope in `_design/CONVENTIONS.md` §12.2, and it is deprecated. Consumers give
 * the user a selectable value instead (ClipboardField selects its input).
 */
export function useCopy(value: string, duration = 1500) {
	const [state, setState] = useState<CopyState>("idle");
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	const copy = useCallback(async () => {
		clearTimeout(timer.current);
		let next: CopyState = "error";
		try {
			// Optional chaining is load-bearing: no `clipboard` at all in http contexts.
			await navigator.clipboard?.writeText(value);
			next = navigator.clipboard ? "copied" : "error";
		} catch {
			next = "error";
		}
		setState(next);
		timer.current = setTimeout(() => setState("idle"), duration);
		return next;
	}, [value, duration]);

	return { copy, state, announcement: ANNOUNCEMENTS[state] };
}

// Size ladder rows (`_design/CONVENTIONS.md` §2.4). `lg` is omitted: a copy
// affordance never leads a layout. `square` is the icon-only form — height as
// width, per the ladder's square rule.
const sizes = {
	xs: { box: "h-6 gap-1 px-2 text-xs", square: "h-6 w-6 p-0", icon: "h-3 w-3" },
	sm: { box: "h-7 gap-1.5 px-2.5 text-xs", square: "h-7 w-7 p-0", icon: "h-3.5 w-3.5" },
	md: { box: "h-8 gap-2 px-3 text-sm", square: "h-8 w-8 p-0", icon: "h-4 w-4" },
} as const;

// The shared emphasis vocabulary (§2.10). `secondary` is the bordered control
// fill, `minimal` the transparent one — the same two rows Button ships under the
// same two names. `primary` is deliberately absent: a copy affordance never leads.
const variants = {
	secondary: "border border-line bg-control text-ink hover:bg-hover",
	minimal: "border border-transparent text-ink-dimmed hover:bg-hover hover:text-ink",
} as const;

// State → ink. Named `stateInk`, not `tones`: `tone` is reserved for the semantic
// status axis (§2.10) and this table is text color.
const stateInk: Record<CopyState, string> = {
	idle: "",
	copied: "text-status-completed-ink",
	error: "text-status-failed-ink",
};

type CopyButtonProps = Omit<React.ComponentPropsWithRef<"button">, "value"> & {
	value: string;
	variant?: keyof typeof variants;
	size?: keyof typeof sizes;
	/** Visible label. Omit for the icon-only square form. */
	children?: React.ReactNode;
};

export function CopyButton({
	value,
	variant = "minimal",
	size = "md",
	className,
	children,
	onClick,
	...props
}: CopyButtonProps) {
	const { copy, state, announcement } = useCopy(value);
	const { box, square, icon } = sizes[size];
	const Icon = state === "copied" ? Check : state === "error" ? X : Copy;

	return (
		<>
			<button
				type="button"
				aria-label={children === undefined ? "Copy" : undefined}
				{...props}
				onClick={(event) => {
					onClick?.(event);
					void copy();
				}}
				className={cn(
					"focus-ring inline-flex shrink-0 items-center justify-center rounded-md transition-colors",
					"disabled:opacity-50 disabled:pointer-events-none",
					variants[variant],
					children === undefined ? square : box,
					stateInk[state],
					className,
				)}
			>
				<Icon aria-hidden="true" className={icon} />
				{children}
			</button>
			{/* Outside the button on purpose: inside, this text would join the button's accessible name. */}
			<output aria-live="polite" className="sr-only">
				{announcement}
			</output>
		</>
	);
}
