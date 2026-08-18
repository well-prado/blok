import { Button } from "@/components/primitives/Buttons";
import { type DropdownMenuEntry, SimpleDropdownMenu } from "@/components/primitives/DropdownMenu";
import { TableCell, useTableDensity } from "@/components/primitives/Table";
import { cn } from "@/lib/utils";
import { MoreVertical } from "lucide-react";

/**
 * The row-action affordance for E2-T4. It plugs into the row slot of
 * `_design/CONVENTIONS.md` §2.13 by COMPOSITION — it renders its own
 * `<TableCell isSticky>` inside a `<TableRow>` the caller writes — so nothing in
 * `Table.tsx` knows it exists and this task edits zero shared files.
 *
 * Adapted from trigger.dev's `TableCellMenu` + `PopoverVerticalEllipseTrigger`,
 * NOT transliterated. The reference's reveal is
 * `hidden group-hover/table-row:block`, i.e. `display:none` until the mouse
 * arrives, which takes the control OUT of the tab order: a keyboard user cannot
 * reach any row action at all, and there is no `focus-within` escape hatch
 * (E2-RESEARCH §B.3, §7.4). That is the bug this component exists to beat, so
 * the reveal here is OPACITY ONLY and the trigger is a permanent tab stop
 * (§2.15 rules 3 and 7).
 *
 * The five things that make it visible, all on one always-rendered `<button>`.
 * Every one was verified in a real browser to emit real CSS and to compute
 * `opacity: 1` in its own state — with the caveat that the reveal is a 150ms
 * transition, so an immediate read after a `Tab` returns the START value, `0`
 * (§2.18's measurement trap; reproduced exactly here, 0 → 1 after 400ms):
 *   - `group-hover/row:`        — the mouse is anywhere on the row
 *   - `group-focus-within/row:` — keyboard focus is anywhere in the row
 *   - `focus-visible:`          — the trigger itself is the focused element
 *   - `data-[state=open]:`      — its own menu is open. Without this the trigger
 *     vanishes the moment the pointer moves off the row and into the portaled
 *     menu it just opened, because the menu is not inside the `<tr>`.
 *   - `pointer-coarse:`         — a touch device has no hover and no Tab key, so
 *     the other four never fire; there the affordance is simply always visible.
 */

// §2.11's fit invariant: the trigger must not grow the row. `xs` is 24px in a
// 28px compact row, `sm` is 28px in a 40px / 44px row — and 24×24 is also the
// WCAG 2.2 AA 2.5.8 minimum target, which the reference's ~16px chevron misses.
const triggerSize = { compact: "xs", default: "sm", comfortable: "sm" } as const;

type TableRowActionsProps = {
	items: DropdownMenuEntry[];
	/**
	 * Identifies the ROW, not the action — §2.15 rule 10. The accessible name
	 * becomes "Actions for run_01H8Z3K9", never a bare "Actions" repeated once per
	 * row with nothing to tell them apart.
	 */
	rowLabel: string;
	/** Forwarded to the cell, so a caller can widen the column. */
	className?: string;
};

export function TableRowActions({ items, rowLabel, className }: TableRowActionsProps) {
	const density = useTableDensity();

	return (
		<TableCell isSticky align="right" className={cn("w-px", className)}>
			{/*
			 * No actions means no affordance: an empty menu is a control that opens
			 * onto nothing. The cell itself stays, so the column keeps its width and
			 * the rows stay aligned — the reference does the same with a plain cell.
			 */}
			{items.length > 0 && (
				<SimpleDropdownMenu
					items={items}
					trigger={
						<Button
							variant="minimal"
							size={triggerSize[density]}
							leadingIcon={<MoreVertical />}
							aria-label={`Actions for ${rowLabel}`}
							// `opacity`, never `hidden` — the whole point (§2.15 rule 7). An
							// `opacity-0` button is still in the tab order, still focusable and
							// still hit-testable; a `display:none` one is none of those.
							//
							// `transition-[opacity,…]` respells Button's own
							// `transition-[color,background-color]` because twMerge keeps only
							// the last transition-property class. Never `transition-colors`:
							// Tailwind v4 folds `outline-color` into it and `.focus-ring` then
							// fades in from the button's own text color (§2.12 rule 10).
							className={cn(
								"opacity-0 transition-[opacity,color,background-color]",
								"group-hover/row:opacity-100 group-focus-within/row:opacity-100",
								"focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100",
							)}
						/>
					}
				/>
			)}
		</TableCell>
	);
}
