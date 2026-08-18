import { CopyButton } from "@/components/primitives/CopyButton";
import { useOverflowFade } from "@/components/primitives/labelOverflowFade";
import { cn } from "@/lib/utils";

// Size ladder rows (`_design/CONVENTIONS.md` §2.4). The height belongs on the
// WRAPPER, not the input: the wrapper carries the 1px border, and with
// the box sizing applied to the inner input only, that border landed OUTSIDE the row —
// rendering 30px/34px where the ladder says 28/32, so a ClipboardField sat 2px
// proud of the Input beside it. The input now fills the row instead of setting it.
const sizes = {
	sm: { row: "h-7", input: "px-2.5 text-xs", button: "sm" },
	md: { row: "h-8", input: "px-3 text-sm", button: "md" },
} as const;

type ClipboardFieldProps = Omit<React.ComponentPropsWithRef<"div">, "children"> & {
	value: string;
	size?: keyof typeof sizes;
	/** Accessible name for the read-only field. */
	label?: string;
	fullWidth?: boolean;
};

/**
 * A read-only value in a box with a copy button welded to its right edge. The
 * input stays a real `<input>` so the value is selectable and keyboard-copyable
 * even where `navigator.clipboard` does not exist.
 */
export function ClipboardField({
	value,
	size = "md",
	label = "Copyable value",
	fullWidth = true,
	className,
	...props
}: ClipboardFieldProps) {
	const { row, input, button } = sizes[size];
	const fade = useOverflowFade<HTMLInputElement>(value);

	return (
		<div
			className={cn(
				"flex items-center rounded-md border border-line bg-control font-mono",
				row,
				fullWidth ? "w-full" : "max-w-fit",
				className,
			)}
			{...props}
		>
			<input
				ref={fade.ref}
				type="text"
				readOnly
				value={value}
				aria-label={label}
				onFocus={(event) => event.currentTarget.select()}
				className={cn("focus-ring min-w-0 flex-1 rounded-md bg-transparent text-ink-dimmed", input, fade.className)}
			/>
			<CopyButton value={value} size={button} className="rounded-l-none border-l-line" />
		</div>
	);
}
