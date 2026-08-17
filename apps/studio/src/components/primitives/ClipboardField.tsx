import { CopyButton } from "@/components/primitives/CopyButton";
import { useOverflowFade } from "@/components/primitives/labelOverflowFade";
import { cn } from "@/lib/utils";

// Size ladder rows (`_design/CONVENTIONS.md` §2.4) — the field IS its row height,
// so the copy button takes the matching row and the two line up.
const sizes = {
	sm: { input: "h-7 px-2.5 text-xs", button: "sm" },
	md: { input: "h-8 px-3 text-sm", button: "md" },
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
	const { input, button } = sizes[size];
	const fade = useOverflowFade<HTMLInputElement>(value);

	return (
		<div
			className={cn(
				"flex items-center rounded-md border border-line bg-control font-mono",
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
