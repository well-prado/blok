import { Spinner } from "@/components/primitives/Spinner";
import { cn } from "@/lib/utils";
import { createLink } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * The button family. `Button`, `LinkButton` and `ButtonContent` live in one file
 * because they share the variant table (`_design/CONVENTIONS.md` §5).
 *
 * Adapted from trigger.dev's `primitives/Buttons.tsx`, NOT transliterated:
 *   - flat single `<button>`, not their `group/button` outer-button/inner-div
 *     nest (§11 — a half-copied nest ships hover states that never fire)
 *   - a plain `as const` table, not their 33-entry `createVariant` cross-product
 *   - `@tanstack/react-router`'s `createLink`, not `@remix-run/react`'s `<Link>`
 */

// Multi-slot (§2.2): the shortcut hint needs its own ink per variant, because a
// key cap legible on `control` is invisible on an accent fill.
const variants = {
	primary: {
		root: "bg-accent text-on-accent hover:bg-accent-hover",
		shortcut: "border-on-accent/40 text-on-accent",
	},
	secondary: {
		root: "border border-line-strong bg-control text-ink hover:bg-hover",
		shortcut: "border-line-bright text-ink-muted",
	},
	minimal: {
		root: "bg-transparent text-ink-dimmed hover:bg-hover hover:text-ink",
		shortcut: "border-line-bright text-ink-muted",
	},
	danger: {
		root: "border border-status-failed/30 bg-status-failed/10 text-status-failed-ink hover:bg-status-failed/20",
		shortcut: "border-status-failed/40 text-status-failed-ink",
	},
} as const;

// §2.4's ladder, verbatim. `icon` sizes every nested svg from one class instead
// of a wrapper, so a caller can drop a lucide icon into `children` too. `square`
// is the icon-only form: the row height becomes the width (§2.4).
const sizes = {
	xs: { root: "h-6 gap-1 px-2 text-xs", icon: "[&_svg]:h-3 [&_svg]:w-3", square: "w-6", spinner: "xs" },
	sm: { root: "h-7 gap-1.5 px-2.5 text-xs", icon: "[&_svg]:h-3.5 [&_svg]:w-3.5", square: "w-7", spinner: "sm" },
	md: { root: "h-8 gap-2 px-3 text-sm", icon: "[&_svg]:h-4 [&_svg]:w-4", square: "w-8", spinner: "md" },
	lg: { root: "h-9 gap-2 px-4 text-sm", icon: "[&_svg]:h-5 [&_svg]:w-5", square: "w-9", spinner: "lg" },
} as const;

// The transition names its properties instead of using `transition-colors`:
// Tailwind v4 folds `outline-color` into that shortcut, so the focus ring fades
// in FROM the button's text color — MEASURED in the browser, mid-transition the
// ring computes to `currentColor` rather than `--color-focus-ring`. The list
// omits `border-color` on purpose: no variant animates its border, and spelling
// that property trips the token guard's `border-*` scan.
const base =
	"focus-ring inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-medium transition-[color,background-color] [&_svg]:shrink-0";

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

type ButtonContentProps = {
	children?: ReactNode;
	variant?: ButtonVariant;
	size?: ButtonSize;
	leadingIcon?: ReactNode;
	trailingIcon?: ReactNode;
	/**
	 * Presentational key hint rendered INSIDE the button, e.g. "⌘K". Studio has
	 * no hotkey subsystem (CONVENTIONS §12.2 rules one out of this task), so this
	 * renders the cap and binds nothing — which is why it is `aria-hidden`:
	 * announcing a shortcut that does not fire would be a lie.
	 */
	shortcut?: string;
	isLoading?: boolean;
};

/** The inner row shared by `Button` and `LinkButton`. Rarely used directly. */
export function ButtonContent({
	children,
	variant = "secondary",
	size = "md",
	leadingIcon,
	trailingIcon,
	shortcut,
	isLoading = false,
}: ButtonContentProps) {
	return (
		<>
			{isLoading ? (
				<Spinner size={sizes[size].spinner} tone="inherit" label={null} />
			) : (
				leadingIcon && (
					<span aria-hidden="true" className="inline-flex">
						{leadingIcon}
					</span>
				)
			)}
			{children}
			{/* A <span>, not a <kbd>: biome's noAriaHiddenOnFocusable counts <kbd> as
			    focusable and rejects the attribute, and §9 forbids a suppression. It is
			    aria-hidden either way, so the element carries no semantics to lose. */}
			{shortcut && (
				<span
					aria-hidden="true"
					className={cn("-mr-0.5 ml-0.5 rounded-md border px-1 font-mono text-[10px]", variants[variant].shortcut)}
				>
					{shortcut}
				</span>
			)}
			{trailingIcon && (
				<span aria-hidden="true" className="inline-flex">
					{trailingIcon}
				</span>
			)}
		</>
	);
}

function chrome(variant: ButtonVariant, size: ButtonSize, square: boolean) {
	// `p-0` after `px-*` — twMerge drops the padding-x it supersedes.
	return cn(base, variants[variant].root, sizes[size].root, sizes[size].icon, square && cn(sizes[size].square, "p-0"));
}

type ButtonProps = React.ComponentPropsWithRef<"button"> & ButtonContentProps;

export function Button({
	className,
	variant = "secondary",
	size = "md",
	leadingIcon,
	trailingIcon,
	shortcut,
	isLoading = false,
	disabled,
	children,
	...props
}: ButtonProps) {
	return (
		// `type` before the spread so a caller can still pass `type="submit"`.
		<button
			type="button"
			className={cn(chrome(variant, size, !children), "disabled:pointer-events-none disabled:opacity-50", className)}
			// Loading implies disabled: the whole point is to stop the second submit.
			disabled={disabled || isLoading}
			aria-busy={isLoading || undefined}
			{...props}
		>
			<ButtonContent
				variant={variant}
				size={size}
				leadingIcon={leadingIcon}
				trailingIcon={trailingIcon}
				shortcut={shortcut}
				isLoading={isLoading}
			>
				{children}
			</ButtonContent>
		</button>
	);
}

// `createLink` is TanStack's own wrapper factory — it keeps `to`/`params`/`search`
// fully typed against the generated route tree, which `ComponentProps<typeof Link>`
// would flatten away. No `disabled`: an <a> has no such state, and §2.6's
// aria-disabled escape hatch is for controls that must stay focusable.
function LinkButtonBase({
	className,
	variant = "secondary",
	size = "md",
	leadingIcon,
	trailingIcon,
	shortcut,
	children,
	...props
}: React.ComponentPropsWithRef<"a"> & Omit<ButtonContentProps, "isLoading">) {
	return (
		<a className={cn(chrome(variant, size, !children), className)} {...props}>
			<ButtonContent
				variant={variant}
				size={size}
				leadingIcon={leadingIcon}
				trailingIcon={trailingIcon}
				shortcut={shortcut}
			>
				{children}
			</ButtonContent>
		</a>
	);
}

export const LinkButton = createLink(LinkButtonBase);
