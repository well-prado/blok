import { cn } from "@/lib/utils";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Modal dialog on `@radix-ui/react-dialog` (`_design/CONVENTIONS.md` §4).
 *
 * Radix supplies the four things this primitive exists to guarantee and that
 * Studio's hand-rolled `fixed inset-0` modals never had: a focus trap, focus
 * RETURN to the trigger on close, `Escape`-to-close, and a body scroll lock.
 * Do not disable any of them.
 *
 * There is no `size` prop on purpose. The §2.4 ladder is a ladder of CONTROL
 * HEIGHTS; a dialog has no row on it, and minting `sm`/`md`/`lg` for widths
 * would redefine those keys. Pass `className="max-w-2xl"` instead.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

// z-50: the canvas (@xyflow/react) makes its own stacking contexts and legacy
// overlays squat on z-40/z-50 (§4.3).
export function DialogOverlay({ className, ...props }: React.ComponentPropsWithRef<typeof DialogPrimitive.Overlay>) {
	return <DialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-canvas/80", className)} {...props} />;
}

type DialogContentProps = React.ComponentPropsWithRef<typeof DialogPrimitive.Content> & {
	/** Render the built-in top-right close button. */
	showClose?: boolean;
};

export function DialogContent({ className, children, showClose = true, ...props }: DialogContentProps) {
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Content
				className={cn(
					"fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
					"flex-col rounded-md border border-line bg-overlay shadow-xl",
					className,
				)}
				{...props}
			>
				{children}
				{showClose && (
					<DialogPrimitive.Close
						aria-label="Close"
						className="focus-ring absolute right-3 top-3 rounded-md p-1 text-ink-dimmed transition-[color,background-color] hover:bg-hover hover:text-ink-strong"
					>
						<X aria-hidden="true" className="h-4 w-4" />
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Content>
		</DialogPortal>
	);
}

export function DialogHeader({ className, ...props }: React.ComponentPropsWithRef<"header">) {
	return <header className={cn("shrink-0 border-b border-line px-4 py-3 pr-12", className)} {...props} />;
}

// Radix warns at runtime when a Dialog has no Title (§9).
export function DialogTitle({ className, ...props }: React.ComponentPropsWithRef<typeof DialogPrimitive.Title>) {
	return <DialogPrimitive.Title className={cn("text-sm font-semibold text-ink-strong", className)} {...props} />;
}

export function DialogDescription({
	className,
	...props
}: React.ComponentPropsWithRef<typeof DialogPrimitive.Description>) {
	return <DialogPrimitive.Description className={cn("mt-1 text-sm text-ink-dimmed", className)} {...props} />;
}

export function DialogBody({ className, ...props }: React.ComponentPropsWithRef<"div">) {
	return <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm text-ink", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentPropsWithRef<"footer">) {
	return (
		<footer
			className={cn("flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3", className)}
			{...props}
		/>
	);
}

/**
 * The flattened convenience wrapper §4.3 requires — ~95% of call sites want one
 * component, not seven.
 */
export function SimpleDialog({
	trigger,
	title,
	description,
	footer,
	children,
	className,
	...rootProps
}: React.ComponentProps<typeof DialogPrimitive.Root> & {
	trigger: ReactNode;
	title: string;
	description?: string;
	footer?: ReactNode;
	className?: string;
}) {
	return (
		<Dialog {...rootProps}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent className={className}>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description && <DialogDescription>{description}</DialogDescription>}
				</DialogHeader>
				<DialogBody>{children}</DialogBody>
				{footer && <DialogFooter>{footer}</DialogFooter>}
			</DialogContent>
		</Dialog>
	);
}
