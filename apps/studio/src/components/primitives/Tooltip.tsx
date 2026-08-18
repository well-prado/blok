import { cn } from "@/lib/utils";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import type * as React from "react";

/**
 * Tooltip — a thin restyle of `@radix-ui/react-tooltip` (CONVENTIONS §4.3:
 * wrap, re-export, restyle; never re-implement).
 *
 * Why Radix and not `title=`: `title` is touch-inaccessible, unstyleable, and
 * fires on a browser-controlled delay. Radix gives focus-open, Escape-close,
 * `aria-describedby` wiring and collision-aware positioning for free — which is
 * exactly the a11y surface a hand-rolled tooltip always gets wrong.
 *
 * Deliberate divergences from the trigger.dev reference:
 *   - the reference's `SimpleTooltip` defaults `tabIndex={-1}` on the trigger,
 *     which makes every tooltip keyboard-unreachable. Ours stays in the tab
 *     order; that is the whole point of not using `title=`.
 *   - no `animate-in` / `slide-in-from-*`: those come from `tailwindcss-animate`,
 *     which Studio does not have and may not add (§0.1). They would emit nothing.
 *   - no arrow. Radix's `Arrow` is an SVG that cannot inherit the content's
 *     border, so a bordered tooltip with an arrow reads as broken. Skipped —
 *     add one only alongside a borderless tooltip variant.
 */

// Two surfaces, not five: a tooltip either sits on the app canvas (`default`)
// or on top of another raised surface (`contrast`), where `overlay` would
// disappear into its host. Multi-slot (§2.2) so the title inside a definition
// tooltip stays legible on both.
//
// `border-line` on both, per the §2.9 elevation ladder: one border token for
// every floating surface. The elevation difference is carried by the shadow
// tier (`shadow-md` — transient), not by a second border token.
const variants = {
	default: "bg-overlay border-line text-ink",
	contrast: "bg-control border-line text-ink-strong",
} as const;

export type TooltipVariant = keyof typeof variants;

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export type TooltipContentProps = React.ComponentPropsWithRef<typeof TooltipPrimitive.Content> & {
	variant?: TooltipVariant;
};

/**
 * Always portaled. `z-50` is mandatory (§4.3): the workflow canvas creates its
 * own stacking contexts and existing overlays squat on z-40/z-50, so a tooltip
 * without it renders *behind* the canvas.
 *
 * No `.focus-ring` here — §2.7: content is not the focusable element.
 */
export function TooltipContent({ className, sideOffset = 6, variant = "default", ...props }: TooltipContentProps) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				sideOffset={sideOffset}
				className={cn("z-50 max-w-xs rounded-md border px-3 py-2 text-xs shadow-md", variants[variant], className)}
				{...props}
			/>
		</TooltipPrimitive.Portal>
	);
}

type SimpleTooltipProps = {
	/** The trigger. Pass `asChild` when this is already an interactive element. */
	button: React.ReactNode;
	content: React.ReactNode;
	side?: TooltipContentProps["side"];
	align?: TooltipContentProps["align"];
	sideOffset?: number;
	variant?: TooltipVariant;
	/** Class for the CONTENT. Use `buttonClassName` for the trigger. */
	className?: string;
	buttonClassName?: string;
	/** Accessible name for the trigger. Required when the trigger has no text (§9). */
	"aria-label"?: string;
	/** Radix's own escape hatch, exposed only here (§4.3). */
	asChild?: boolean;
	disableHoverableContent?: boolean;
	/** ms before hover opens it. Focus always opens immediately, delay or not. */
	delayDuration?: number;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
};

/**
 * The flattened wrapper — §4.3 requires one, because ~95% of call sites want a
 * single component rather than four, and that is what makes the 127 existing
 * `title=` attributes mechanically replaceable later.
 */
export function SimpleTooltip({
	button,
	content,
	side,
	align,
	sideOffset,
	variant,
	className,
	buttonClassName,
	asChild = false,
	disableHoverableContent = false,
	// Radix's provider default is 700ms (sluggish); the reference uses 0 (fires
	// on every incidental mouse pass). 200ms is the house value.
	delayDuration = 200,
	open,
	onOpenChange,
	"aria-label": ariaLabel,
}: SimpleTooltipProps) {
	return (
		<TooltipProvider disableHoverableContent={disableHoverableContent} delayDuration={delayDuration}>
			<TooltipRoot open={open} onOpenChange={onOpenChange} delayDuration={delayDuration}>
				<TooltipTrigger
					type={asChild ? undefined : "button"}
					asChild={asChild}
					aria-label={ariaLabel}
					className={cn(!asChild && "focus-ring h-fit rounded-md", buttonClassName)}
				>
					{button}
				</TooltipTrigger>
				<TooltipContent side={side} align={align} sideOffset={sideOffset} variant={variant} className={className}>
					{content}
				</TooltipContent>
			</TooltipRoot>
		</TooltipProvider>
	);
}

// The GLYPH column of the size ladder (§2.4), same as Spinner: an `md` info icon
// sits in an `md` control row without changing its height.
const iconSizes = {
	xs: "h-3 w-3",
	sm: "h-3.5 w-3.5",
	md: "h-4 w-4",
	lg: "h-5 w-5",
} as const;

type InfoIconTooltipProps = Omit<SimpleTooltipProps, "button" | "asChild" | "buttonClassName"> & {
	size?: keyof typeof iconSizes;
	/** Accessible name for the icon-only trigger (§9). */
	label?: string;
	iconClassName?: string;
};

/** The "what is this field?" affordance: an icon-only trigger that still has a name. */
export function InfoIconTooltip({
	// `md`, per §2.4: it is the mandated default for every sized primitive, and an
	// info icon has to line up with the `md` control it annotates.
	size = "md",
	label = "More information",
	iconClassName,
	...props
}: InfoIconTooltipProps) {
	return (
		<SimpleTooltip
			{...props}
			buttonClassName="rounded-full text-ink-muted hover:text-ink"
			button={<Info aria-hidden="true" className={cn("shrink-0", iconSizes[size], iconClassName)} />}
			// The trigger is a real <button>; without this it has no accessible name.
			aria-label={label}
		/>
	);
}
