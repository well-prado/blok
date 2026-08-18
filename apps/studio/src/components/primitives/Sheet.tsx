import { cn } from "@/lib/utils";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * An edge-anchored Dialog. A Sheet IS a Dialog with a different position, which
 * is why §4.1 gives both to `@radix-ui/react-dialog` and why this file wraps the
 * same primitive rather than inventing a second overlay stack.
 *
 * Focus trap, focus return, `Escape` and the scroll lock all come from Radix —
 * identical guarantees to `Dialog.tsx`.
 */
export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

// The variant table: which edge the panel is anchored to. Cross-axis extent is
// the caller's `className` (`w-1/3`, `h-64`) — see Dialog.tsx on why there is
// no `size` prop.
const sides = {
	top: "inset-x-0 top-0 max-h-[85vh] w-full border-b",
	right: "inset-y-0 right-0 h-full w-[22rem] max-w-[85vw] border-l",
	bottom: "inset-x-0 bottom-0 max-h-[85vh] w-full border-t",
	left: "inset-y-0 left-0 h-full w-[22rem] max-w-[85vw] border-r",
} as const;

type SheetContentProps = React.ComponentPropsWithRef<typeof SheetPrimitive.Content> & {
	side?: keyof typeof sides;
	showClose?: boolean;
};

export function SheetContent({ className, children, side = "right", showClose = true, ...props }: SheetContentProps) {
	return (
		<SheetPrimitive.Portal>
			<SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-canvas/80" />
			<SheetPrimitive.Content
				className={cn("fixed z-50 flex flex-col border-line bg-overlay shadow-xl", sides[side], className)}
				{...props}
			>
				{children}
				{showClose && (
					<SheetPrimitive.Close
						aria-label="Close"
						className="focus-ring absolute right-3 top-3 rounded-md p-1 text-ink-dimmed transition-[color,background-color] hover:bg-hover hover:text-ink-strong"
					>
						<X aria-hidden="true" className="h-4 w-4" />
					</SheetPrimitive.Close>
				)}
			</SheetPrimitive.Content>
		</SheetPrimitive.Portal>
	);
}

export function SheetHeader({ className, ...props }: React.ComponentPropsWithRef<"header">) {
	return <header className={cn("shrink-0 border-b border-line px-4 py-3 pr-12", className)} {...props} />;
}

export function SheetTitle({ className, ...props }: React.ComponentPropsWithRef<typeof SheetPrimitive.Title>) {
	return <SheetPrimitive.Title className={cn("text-sm font-semibold text-ink-strong", className)} {...props} />;
}

export function SheetDescription({
	className,
	...props
}: React.ComponentPropsWithRef<typeof SheetPrimitive.Description>) {
	return <SheetPrimitive.Description className={cn("mt-1 text-sm text-ink-dimmed", className)} {...props} />;
}

export function SheetBody({ className, ...props }: React.ComponentPropsWithRef<"div">) {
	return <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm text-ink", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: React.ComponentPropsWithRef<"footer">) {
	return (
		<footer
			className={cn("flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3", className)}
			{...props}
		/>
	);
}

/** Flattened wrapper (§4.3). */
export function SimpleSheet({
	trigger,
	title,
	description,
	side = "right",
	footer,
	children,
	className,
	...rootProps
}: React.ComponentProps<typeof SheetPrimitive.Root> & {
	trigger: ReactNode;
	title: string;
	description?: string;
	side?: keyof typeof sides;
	footer?: ReactNode;
	className?: string;
}) {
	return (
		<Sheet {...rootProps}>
			<SheetTrigger asChild>{trigger}</SheetTrigger>
			<SheetContent side={side} className={className}>
				<SheetHeader>
					<SheetTitle>{title}</SheetTitle>
					{description && <SheetDescription>{description}</SheetDescription>}
				</SheetHeader>
				<SheetBody>{children}</SheetBody>
				{footer && <SheetFooter>{footer}</SheetFooter>}
			</SheetContent>
		</Sheet>
	);
}
