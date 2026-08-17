import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

// Ladder §2.4: the outer control takes the row height, each segment keeps the
// row's padding-x and text size. The 2px inset padding is what makes the inner
// nested corner read correctly at the shared `rounded-md` (§2.5).
const sizes = {
	xs: { container: "h-6", option: "px-2 text-xs" },
	sm: { container: "h-7", option: "px-2.5 text-xs" },
	md: { container: "h-8", option: "px-3 text-sm" },
	lg: { container: "h-9", option: "px-4 text-sm" },
} as const;

type SegmentedControlOption = {
	label: ReactNode;
	value: string;
	disabled?: boolean;
};

type SegmentedControlProps = {
	/** Shared radio `name` — also what groups the arrow-key cycling. */
	name: string;
	/** Names the group for assistive tech. Rendered as a `<legend>`. */
	label: string;
	options: SegmentedControlOption[];
	/** Pass for a controlled control; omit and use `defaultValue` for uncontrolled. */
	value?: string;
	defaultValue?: string;
	onChange?: (value: string) => void;
	size?: keyof typeof sizes;
	disabled?: boolean;
	fullWidth?: boolean;
	className?: string;
};

/**
 * A row of mutually-exclusive options, built on REAL radios inside a real
 * `<fieldset>` — the reference builds this on Headless UI's `RadioGroup` plus
 * framer-motion, neither of which is installed and neither of which may be
 * added (§4.1). The native version gets arrow-key cycling, the group name and
 * form submission for free.
 *
 * The radio itself is stretched invisibly over its segment rather than hidden,
 * so `.focus-ring` sits on the element that actually receives focus (§2.7)
 * while still being drawn on the segment the user sees.
 */
export function SegmentedControl({
	name,
	label,
	options,
	value,
	defaultValue,
	onChange,
	size = "md",
	disabled,
	fullWidth,
	className,
}: SegmentedControlProps) {
	const { container, option } = sizes[size];
	const isControlled = value !== undefined;

	return (
		<fieldset
			disabled={disabled}
			className={cn(
				"flex min-w-0 items-stretch gap-0.5 rounded-md border border-line bg-control p-0.5",
				fullWidth ? "w-full" : "w-fit",
				container,
				className,
			)}
		>
			{/* Always visually hidden: a `<legend>` is laid out specially and would
			    break the flex row. Put a visible `<Label>` above the control instead. */}
			<legend className="sr-only">{label}</legend>
			{options.map((opt) => (
				<label
					key={opt.value}
					className={cn(
						"relative flex min-w-0 items-center justify-center rounded-md font-medium text-ink-dimmed transition-colors",
						"hover:text-ink has-[:checked]:bg-hover has-[:checked]:text-ink-strong",
						"has-[:disabled]:opacity-50",
						fullWidth && "flex-1",
						option,
					)}
				>
					<input
						type="radio"
						name={name}
						value={opt.value}
						disabled={opt.disabled}
						onChange={() => onChange?.(opt.value)}
						{...(isControlled ? { checked: value === opt.value } : { defaultChecked: defaultValue === opt.value })}
						className="focus-ring absolute inset-0 m-0 cursor-pointer appearance-none rounded-md disabled:pointer-events-none"
					/>
					<span className="pointer-events-none truncate">{opt.label}</span>
				</label>
			))}
		</fieldset>
	);
}
