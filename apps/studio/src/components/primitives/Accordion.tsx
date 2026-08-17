import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { createContext, useContext, useId, useState } from "react";

/**
 * Accordion on native `<details>`/`<summary>` — `@radix-ui/react-accordion` is
 * NOT installed and §4.2 rejects it, so the platform does the work:
 *
 *   - `<summary>` is focusable, and Enter/Space toggle it, with no JS;
 *   - the open/closed state is the `open` attribute, so it is exposed to AT
 *     and to CSS (`group-open:`) for free;
 *   - browser find-in-page reaches collapsed content (Chromium), which a
 *     JS accordion that unmounts its panel never can.
 *
 * `exclusive` mode uses the native `name` attribute on `<details>`: same-named
 * details elements auto-close each other. Baseline since Chrome 120 / Safari
 * 17.2 / Firefox 130 — on an older browser the group degrades to independent
 * items opening together, which is a cosmetic loss, not a broken control.
 */
const AccordionGroupName = createContext<string | undefined>(undefined);

export function Accordion({
	className,
	exclusive = false,
	children,
	...props
}: React.ComponentPropsWithRef<"div"> & { exclusive?: boolean }) {
	const name = useId();
	return (
		<AccordionGroupName.Provider value={exclusive ? name : undefined}>
			<div className={cn("divide-y divide-line overflow-hidden rounded-md border border-line", className)} {...props}>
				{children}
			</div>
		</AccordionGroupName.Provider>
	);
}

type AccordionItemProps = Omit<React.ComponentPropsWithRef<"details">, "title" | "open"> & {
	title: React.ReactNode;
	/** Trailing slot in the summary row — a count, a status chip, a duration. */
	aside?: React.ReactNode;
	disabled?: boolean;
	defaultOpen?: boolean;
};

export function AccordionItem({
	className,
	title,
	aside,
	disabled = false,
	defaultOpen = false,
	children,
	...props
}: AccordionItemProps) {
	const name = useContext(AccordionGroupName);
	// The DOM owns the toggle; this only mirrors it back so React re-renders do
	// not stomp the `open` attribute. `onToggle` also fires on the item that an
	// exclusive sibling auto-closed, so the mirror stays true there too.
	const [open, setOpen] = useState(defaultOpen);
	return (
		<details
			name={name}
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
			className={cn("group bg-raised", className)}
			{...props}
		>
			{/* `<summary>` is natively a button-like control; `.focus-ring` goes on it
			    because it is the element that actually receives focus (§2.7). */}
			{/* Disabled is §2.6's second recipe: `<summary>` has no native `disabled`,
			    so aria-disabled + the two classes + an early return in the handlers.
			    Both handlers are needed — a browser activates a summary on click AND
			    on Enter/Space, and preventDefault is what suppresses the toggle. */}
			<summary
				aria-disabled={disabled || undefined}
				onClick={disabled ? (event) => event.preventDefault() : undefined}
				onKeyDown={
					disabled
						? (event) => {
								if (event.key === "Enter" || event.key === " ") event.preventDefault();
							}
						: undefined
				}
				className={cn(
					"focus-ring flex h-9 cursor-default list-none items-center gap-2 px-3 text-sm text-ink",
					"transition-colors hover:bg-hover hover:text-ink-strong [&::-webkit-details-marker]:hidden",
					disabled && "pointer-events-none opacity-50",
				)}
			>
				<ChevronRight
					aria-hidden="true"
					className="h-4 w-4 shrink-0 text-ink-dimmed transition-transform group-open:rotate-90"
				/>
				<span className="min-w-0 flex-1 truncate text-left">{title}</span>
				{aside}
			</summary>
			<div className="border-t border-line px-3 py-2.5 text-sm text-ink-dimmed">{children}</div>
		</details>
	);
}
