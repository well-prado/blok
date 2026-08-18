import { Checkbox } from "@/components/primitives/Checkbox";
import { TableCell, TableHeaderCell } from "@/components/primitives/Table";
import { cn } from "@/lib/utils";

/**
 * The selection column: one checkbox cell per row plus the select-all header
 * cell. A slot component in the sense of `_design/CONVENTIONS.md` §2.13 — it
 * composes `<TableCell>` + `<Checkbox>` and edits `Table.tsx` not at all.
 *
 * Two structural wins over trigger.dev's `TaskRunsTable`, which passes its
 * checkboxes only `checked`/`onChange`/`ref`/`onKeyDown`:
 *   - `Checkbox`'s `label` is REQUIRED, so a row checkbox cannot ship anonymous.
 *     Theirs announce as "checkbox, not checked" with no idea which row (§2.15
 *     rule 6). Here the name always identifies the row.
 *   - the row checkbox is an ordinary tab stop with NO `tabIndex` of its own
 *     (§2.15 rule 3). Their arrow-key walk over a ref array of checkboxes is not
 *     reproduced: range selection is the hook's `selectRange`, reached here with
 *     shift-click.
 */

/**
 * React maps a checkbox's `onChange` onto the underlying CLICK event, so
 * `nativeEvent` carries the modifier keys — including for a keyboard Space,
 * which browsers deliver as a synthetic click. That is the whole reason this
 * reads shift here rather than adding a second `onClick` handler that would
 * double-fire.
 */
function isExtend(event: React.ChangeEvent<HTMLInputElement>): boolean {
	return event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey;
}

export function TableSelectCell({
	label,
	checked,
	onToggle,
	disabled = false,
	className,
}: {
	/** Names the ROW, not the control: "run_01H8Z3K9". Becomes "Select run_01H8Z3K9". */
	label: string;
	checked: boolean;
	/** `extend` is true for shift-click / shift-space — hand it to `toggle(id, extend)`. */
	onToggle: (extend: boolean) => void;
	disabled?: boolean;
	className?: string;
}) {
	return (
		// `w-px` collapses the column to its content; the row height stays the
		// density ladder's (§2.11), so no `py-*` here — that is a review failure.
		<TableCell className={cn("w-px pr-0", className)}>
			<Checkbox
				size="sm"
				checked={checked}
				disabled={disabled}
				onChange={(event) => onToggle(isExtend(event))}
				// `select-none` is REQUIRED, not stylistic: an `sr-only` twin stays
				// selectable and a mouse-drag copies both strings (§2.12 rule 11,
				// enforced by tokens.test.ts).
				label={<span className="sr-only select-none">Select {label}</span>}
			/>
		</TableCell>
	);
}

export function TableSelectAllCell({
	total,
	allSelected,
	someSelected,
	onToggleAll,
	disabled = false,
	className,
}: {
	/** Row count on the page — it is in the accessible name, so it must be honest. */
	total: number;
	allSelected: boolean;
	/** At least one selected. With `allSelected` false this is the indeterminate state. */
	someSelected: boolean;
	onToggleAll: () => void;
	disabled?: boolean;
	className?: string;
}) {
	return (
		// NOT `hiddenLabel`: that prop wraps the CHILDREN in an `sr-only` span, which
		// would hide the checkbox itself. The accessible name comes from the
		// checkbox's own label.
		<TableHeaderCell className={cn("w-px pr-0", className)}>
			<Checkbox
				size="sm"
				checked={allSelected}
				disabled={disabled}
				// `indeterminate` is a DOM PROPERTY, not a JSX attribute — React 19
				// forwards an unknown attribute and it does nothing. Block body, because
				// a callback ref that RETURNS a value is a React 19 error.
				ref={(element) => {
					if (element) element.indeterminate = someSelected && !allSelected;
				}}
				onChange={onToggleAll}
				label={<span className="sr-only select-none">Select all {total} rows</span>}
			/>
		</TableHeaderCell>
	);
}
