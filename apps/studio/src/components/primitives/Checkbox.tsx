import { cn } from "@/lib/utils";
import { type ReactNode, useId } from "react";

// The box takes the ICON column of the ladder (§2.4) — like Spinner, it is a
// glyph, so an `md` Checkbox lines up inside an `md` row. `box` carries the
// nudge that centres it on the label's first line.
const sizes = {
	xs: { box: "h-3 w-3 mt-0.5", label: "text-xs", gap: "gap-1" },
	sm: { box: "h-3.5 w-3.5 mt-0.5", label: "text-xs", gap: "gap-1.5" },
	md: { box: "h-4 w-4 mt-0.5", label: "text-sm", gap: "gap-2" },
	lg: { box: "h-5 w-5 mt-0", label: "text-sm", gap: "gap-2" },
} as const;

type CheckboxProps = Omit<React.ComponentPropsWithRef<"input">, "size" | "type"> & {
	size?: keyof typeof sizes;
	/** Required: an unlabelled checkbox is a bug, not a variant. */
	label: ReactNode;
	description?: ReactNode;
	/** Applied to the wrapper; `className` goes on the input itself. */
	containerClassName?: string;
};

/**
 * A REAL `<input type="checkbox">` under the styling. Radix's checkbox is not
 * installed and may not be added (§4.2), which is the better outcome here: the
 * native control submits with its form, supports `indeterminate`, and is
 * already keyboard-operable, so the only thing left to do is recolour it with
 * `accent-color`.
 *
 * There is deliberately no `rounded-*`: a native checkbox's corner radius is
 * not author-controllable, so a radius class would be a no-op that reads as a
 * §2.5 decision.
 */
export function Checkbox({
	className,
	containerClassName,
	id,
	size = "md",
	label,
	description,
	...props
}: CheckboxProps) {
	const generatedId = useId();
	const inputId = id ?? generatedId;
	const { box, label: labelClass, gap } = sizes[size];

	return (
		<div className={cn("flex items-start", gap, containerClassName)}>
			<input
				id={inputId}
				type="checkbox"
				className={cn(
					"peer focus-ring shrink-0 cursor-pointer accent-accent",
					"disabled:pointer-events-none disabled:opacity-50",
					box,
					className,
				)}
				{...props}
			/>
			<div className="grid gap-0.5 peer-disabled:opacity-50">
				<label htmlFor={inputId} className={cn("cursor-pointer select-none text-ink", labelClass)}>
					{label}
				</label>
				{description && <p className={cn("text-ink-muted", labelClass)}>{description}</p>}
			</div>
		</div>
	);
}
