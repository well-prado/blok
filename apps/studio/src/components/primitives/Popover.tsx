import { cn } from "@/lib/utils";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ReactNode } from "react";

/**
 * Non-modal floating panel on `@radix-ui/react-popover` (§4). Radix gives
 * collision-aware positioning, outside-click and `Escape` dismissal, and focus
 * return to the trigger.
 *
 * A Popover holds arbitrary content. If you want a LIST OF COMMANDS, use
 * `DropdownMenu.tsx` — it has the roving tabindex and `role="menu"` semantics
 * this one deliberately does not.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
	className,
	align = "center",
	sideOffset = 6,
	...props
}: React.ComponentPropsWithRef<typeof PopoverPrimitive.Content>) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Content
				align={align}
				sideOffset={sideOffset}
				// No `.focus-ring` here: Radix moves focus into the content and the
				// panel itself is the affordance (§2.7).
				className={cn(
					// §2.9 elevation: anchored + dismissible → the `floating` tier.
					"z-50 min-w-max rounded-md border border-line bg-overlay p-3 text-sm text-ink shadow-lg",
					className,
				)}
				// Radix exposes the collision-clamped height; without it a long
				// popover overflows the viewport instead of scrolling.
				style={{ maxHeight: "var(--radix-popover-content-available-height)" }}
				{...props}
			/>
		</PopoverPrimitive.Portal>
	);
}

export function PopoverHeading({ className, ...props }: React.ComponentPropsWithRef<"p">) {
	return <p className={cn("mb-1.5 text-xs font-semibold text-ink-strong", className)} {...props} />;
}

/** Flattened wrapper (§4.3). */
export function SimplePopover({
	trigger,
	heading,
	children,
	className,
	align,
	side,
	...rootProps
}: React.ComponentProps<typeof PopoverPrimitive.Root> & {
	trigger: ReactNode;
	heading?: string;
	className?: string;
	align?: React.ComponentProps<typeof PopoverPrimitive.Content>["align"];
	side?: React.ComponentProps<typeof PopoverPrimitive.Content>["side"];
}) {
	return (
		<Popover {...rootProps}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent align={align} side={side} className={className}>
				{heading && <PopoverHeading>{heading}</PopoverHeading>}
				{children}
			</PopoverContent>
		</Popover>
	);
}
