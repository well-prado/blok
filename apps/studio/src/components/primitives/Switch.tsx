import { cn } from "@/lib/utils";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { type ReactNode, useId } from "react";

/**
 * §2.4's ladder has no track column, so the TRACK HEIGHT is taken from the icon
 * column (`sm` 14px, `md` 16px, `lg` 20px) — a switch is a glyph-scale control
 * like Spinner, so an `md` Switch sits in an `md` row without stretching it.
 * The track is twice its height minus the border, and the thumb travel is
 * width − thumb − border, which is why the numbers are not round.
 *
 * `xs` is omitted deliberately: a 12px track has no usable hit target. §2.4
 * permits omitting a row; it forbids redefining one.
 */
const sizes = {
	sm: { root: "h-3.5 w-6", thumb: "h-2.5 w-2.5 data-[state=checked]:translate-x-2.5", label: "text-xs" },
	md: { root: "h-4 w-7", thumb: "h-3 w-3 data-[state=checked]:translate-x-3", label: "text-sm" },
	lg: { root: "h-5 w-9", thumb: "h-4 w-4 data-[state=checked]:translate-x-4", label: "text-sm" },
} as const;

type SwitchProps = React.ComponentPropsWithRef<typeof SwitchPrimitive.Root> & {
	size?: keyof typeof sizes;
	/** Omit only if you pass `aria-label` — an unnamed switch is unusable. */
	label?: ReactNode;
	labelPosition?: "left" | "right";
	containerClassName?: string;
};

/**
 * Radix Switch — the one Radix package E1-T5 owns (§4.1). Radix gives the
 * `role="switch"`, the `aria-checked` bookkeeping, Space/Enter activation and
 * the hidden form input; everything below is styling.
 */
export function Switch({
	className,
	containerClassName,
	id,
	size = "md",
	label,
	labelPosition = "right",
	...props
}: SwitchProps) {
	const generatedId = useId();
	const switchId = id ?? generatedId;
	const { root, thumb, label: labelClass } = sizes[size];

	// `<button>` is a labelable element, so `htmlFor` both names the switch and
	// makes the text a hit target.
	const labelElement = label ? (
		<label htmlFor={switchId} className={cn("cursor-pointer select-none text-ink", labelClass)}>
			{label}
		</label>
	) : null;

	return (
		<div className={cn("inline-flex items-center gap-2", containerClassName)}>
			{labelPosition === "left" && labelElement}
			<SwitchPrimitive.Root
				id={switchId}
				className={cn(
					// `transition-[background-color]`, not `transition-colors`: the latter
					// includes `outline-color`, which pins `.focus-ring` to `currentcolor`.
					"focus-ring inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
					"transition-[background-color]",
					"data-[state=unchecked]:bg-line-bright data-[state=checked]:bg-accent",
					"disabled:pointer-events-none disabled:opacity-50",
					root,
					className,
				)}
				{...props}
			>
				<SwitchPrimitive.Thumb
					className={cn(
						"pointer-events-none block rounded-full bg-ink-strong transition-transform data-[state=unchecked]:translate-x-0",
						thumb,
					)}
				/>
			</SwitchPrimitive.Root>
			{labelPosition === "right" && labelElement}
		</div>
	);
}
