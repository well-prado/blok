import { useCopy } from "@/components/primitives/CopyButton";
import { cn } from "@/lib/utils";
import { Check, Copy, X } from "lucide-react";

const tones = {
	idle: "text-ink-dimmed hover:text-ink",
	copied: "text-status-completed-ink",
	error: "text-status-failed-ink",
} as const;

type CopyableTextProps = Omit<React.ComponentPropsWithRef<"button">, "value" | "children"> & {
	/** The text shown to the user. */
	value: string;
	/** What actually lands on the clipboard, when it differs from what is shown. */
	copyValue?: string;
	/** Ids and hashes read better monospaced; prose does not. */
	mono?: boolean;
};

/**
 * Inline text that is itself the copy target — the whole label is the button, so
 * the hit area is the id, not a 12px icon beside it. The icon is a hover/focus
 * affordance only.
 */
export function CopyableText({ value, copyValue, mono = true, className, onClick, ...props }: CopyableTextProps) {
	const { copy, state, announcement } = useCopy(copyValue ?? value);
	const Icon = state === "copied" ? Check : state === "error" ? X : Copy;

	return (
		<>
			<button
				type="button"
				aria-label={`Copy ${value}`}
				{...props}
				onClick={(event) => {
					onClick?.(event);
					void copy();
				}}
				className={cn(
					"focus-ring group inline-flex max-w-full items-center gap-1.5 rounded-md px-1 text-left transition-[color,background-color]",
					"disabled:opacity-50 disabled:pointer-events-none",
					mono && "font-mono",
					tones[state],
					className,
				)}
			>
				<span className="truncate">{value}</span>
				<Icon
					aria-hidden="true"
					className={cn(
						"h-3.5 w-3.5 shrink-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
						state === "idle" ? "opacity-0" : "opacity-100",
					)}
				/>
			</button>
			<output aria-live="polite" className="sr-only select-none">
				{announcement}
			</output>
		</>
	);
}
