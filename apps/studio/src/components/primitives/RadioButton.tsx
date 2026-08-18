import { cn } from "@/lib/utils";
import { type ReactNode, useId } from "react";

// Icon column of the ladder (§2.4), same as Checkbox — the two have to line up
// when a form mixes them.
const sizes = {
	xs: { box: "h-3 w-3 mt-0.5", label: "text-xs", gap: "gap-1" },
	sm: { box: "h-3.5 w-3.5 mt-0.5", label: "text-xs", gap: "gap-1.5" },
	md: { box: "h-4 w-4 mt-0.5", label: "text-sm", gap: "gap-2" },
	lg: { box: "h-5 w-5 mt-0", label: "text-sm", gap: "gap-2" },
} as const;

type RadioButtonProps = Omit<React.ComponentPropsWithRef<"input">, "size" | "type"> & {
	size?: keyof typeof sizes;
	label: ReactNode;
	description?: ReactNode;
	containerClassName?: string;
};

/**
 * A REAL `<input type="radio">`. Radix's radio-group is not installed and may
 * not be added (§4.2) — and the native control is the better trade here anyway:
 * put several of these inside a `<Fieldset legend="…">` sharing one `name` and
 * the browser supplies the roving tabindex, the arrow-key cycling and the group
 * name with no JS at all.
 */
export function RadioButton({
	className,
	containerClassName,
	id,
	size = "md",
	label,
	description,
	...props
}: RadioButtonProps) {
	const generatedId = useId();
	const inputId = id ?? generatedId;
	const { box, label: labelClass, gap } = sizes[size];

	return (
		<div className={cn("flex items-start", gap, containerClassName)}>
			<input
				id={inputId}
				type="radio"
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
