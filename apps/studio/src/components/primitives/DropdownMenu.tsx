import { cn } from "@/lib/utils";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Download, FileJson, FileSpreadsheet } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

/**
 * Command menu on `@radix-ui/react-dropdown-menu` (§4). This is the one that
 * carries `role="menu"`, roving tabindex, typeahead, and focus return — i.e.
 * everything `shared/ExportMenu.tsx` had none of (zero `aria-*`, zero `role=`).
 *
 * Use `Popover.tsx` instead when the panel holds arbitrary content rather than
 * a list of commands; menu semantics on non-commands is worse than no
 * semantics.
 */
export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuGroup = MenuPrimitive.Group;

export function DropdownMenuTrigger({
	className,
	...props
}: React.ComponentPropsWithRef<typeof MenuPrimitive.Trigger>) {
	return <MenuPrimitive.Trigger className={cn("focus-ring rounded-md", className)} {...props} />;
}

export function DropdownMenuContent({
	className,
	align = "end",
	sideOffset = 6,
	...props
}: React.ComponentPropsWithRef<typeof MenuPrimitive.Content>) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Content
				align={align}
				sideOffset={sideOffset}
				className={cn(
					// §2.9 elevation: anchored + dismissible → the `floating` tier.
					"z-50 min-w-44 overflow-hidden rounded-md border border-line bg-overlay p-1 shadow-lg",
					className,
				)}
				{...props}
			/>
		</MenuPrimitive.Portal>
	);
}

// A menu item is not a natively disable-able element, so §2.6's second recipe
// applies: Radix supplies `aria-disabled` and swallows the select; these two
// classes supply the rest.
//
// `tone` is the SEMANTIC STATUS axis (§2.10), so these are the canonical status
// keys — `neutral` for "no status" and `error` for the destructive item. A menu
// item has no use for `info`/`success`/`warning`, and §2.10 lets a primitive omit
// the values it has no use for.
const itemTones = {
	neutral: "text-ink data-[highlighted]:bg-hover data-[highlighted]:text-ink-strong",
	error: "text-status-failed-ink data-[highlighted]:bg-status-failed/10",
} as const;

type DropdownMenuItemProps = React.ComponentPropsWithRef<typeof MenuPrimitive.Item> & {
	tone?: keyof typeof itemTones;
};

export function DropdownMenuItem({ className, tone = "neutral", ...props }: DropdownMenuItemProps) {
	return (
		<MenuPrimitive.Item
			className={cn(
				"flex h-8 cursor-default select-none items-center gap-2 rounded-md px-3 text-sm",
				itemTones[tone],
				"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithRef<typeof MenuPrimitive.Label>) {
	return (
		<MenuPrimitive.Label
			className={cn("px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted", className)}
			{...props}
		/>
	);
}

export function DropdownMenuSeparator({
	className,
	...props
}: React.ComponentPropsWithRef<typeof MenuPrimitive.Separator>) {
	return <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

export type DropdownMenuEntry = {
	label: string;
	onSelect: () => void;
	icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
	disabled?: boolean;
	tone?: keyof typeof itemTones;
};

/** Flattened wrapper (§4.3) — what makes a hand-rolled menu mechanically replaceable. */
export function SimpleDropdownMenu({
	trigger,
	items,
	label,
	align,
	className,
	...rootProps
}: React.ComponentProps<typeof MenuPrimitive.Root> & {
	trigger: ReactNode;
	items: DropdownMenuEntry[];
	label?: string;
	align?: React.ComponentProps<typeof MenuPrimitive.Content>["align"];
	className?: string;
}) {
	return (
		<DropdownMenu {...rootProps}>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align={align} className={className}>
				{label && <DropdownMenuLabel>{label}</DropdownMenuLabel>}
				{items.map(({ label: itemLabel, onSelect, icon: Icon, disabled, tone }) => (
					<DropdownMenuItem key={itemLabel} onSelect={onSelect} disabled={disabled} tone={tone}>
						{Icon && <Icon aria-hidden className="h-4 w-4 shrink-0" />}
						{itemLabel}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// The §2.4 ladder rows, verbatim. `ExportMenu`'s historical prop only ever took
// these two.
const triggerSizes = {
	sm: { box: "h-7 gap-1.5 px-2.5 text-xs", icon: "h-3.5 w-3.5" },
	md: { box: "h-8 gap-2 px-3 text-sm", icon: "h-4 w-4" },
} as const;

/**
 * Fold-in of `shared/ExportMenu.tsx` (§6). Same exported name, same props, same
 * on-screen text — the old file becomes a one-line re-export of this.
 */
export function ExportMenu({
	onExportJson,
	onExportCsv,
	label = "Export",
	size = "sm",
}: {
	onExportJson: () => void;
	onExportCsv: () => void;
	label?: string;
	size?: keyof typeof triggerSizes;
}) {
	const { box, icon } = triggerSizes[size];
	return (
		<SimpleDropdownMenu
			trigger={
				<button
					type="button"
					className={cn(
						"inline-flex items-center rounded-md bg-control font-medium text-ink transition-[color,background-color] hover:bg-hover hover:text-ink-strong",
						box,
					)}
				>
					<Download aria-hidden="true" className={icon} />
					{label}
					<ChevronDown aria-hidden="true" className={cn(icon, "transition-transform")} />
				</button>
			}
			items={[
				{ label: "Export as JSON", onSelect: onExportJson, icon: FileJson },
				{ label: "Export as CSV", onSelect: onExportCsv, icon: FileSpreadsheet },
			]}
		/>
	);
}
