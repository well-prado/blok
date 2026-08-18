import { useRef, useState } from "react";

/**
 * The ONE selection model (`_design/CONVENTIONS.md` §2.14). A hook owned by the
 * caller — not a context, and never state owned by `<Table>`. E2-T3's keyboard
 * nav and E2-T5's bulk bar both read this, so they cannot diverge.
 *
 * Adapted from trigger.dev's `SelectedItemsProvider`, NOT transliterated:
 *   - a hook, not a provider: Studio's bulk toolbar is already a SIBLING of the
 *     table and takes `selectedIds` as a prop, so a provider would wrap only its
 *     own children. Their context exists because their bulk UI is a resizable
 *     side panel two components away, and it pays for that with
 *     `useSelectedItems(enabled)` returning `{}` cast to the context type — an
 *     `any` in all but name, which this repo forbids.
 *   - `selectRange` lives HERE, because it is the one operation the caller
 *     cannot do trivially: it needs the ordered `ids` array the hook already
 *     closed over. Their range-select is a hand-rolled ref array over the DOM
 *     checkboxes with an acknowledged off-by-one (their own comment says so) and
 *     a wrong dependency array. Do not copy it.
 *   - `max` refuses instead of truncating silently. Theirs `console.warn`s and
 *     drops the excess, so the user sees a selection they do not have.
 */
export type TableSelection = {
	selected: ReadonlySet<string>;
	has: (id: string) => boolean;
	/**
	 * `extend` is shift-click / shift-space: select from the last-touched row to
	 * this one. Callers that do not care pass nothing — `(id) => void` still
	 * satisfies this type.
	 */
	toggle: (id: string, extend?: boolean) => void;
	selectRange: (fromId: string, toId: string) => void;
	selectAll: () => void;
	clear: () => void;
	allSelected: boolean;
	/** At least one selected → the select-all checkbox's `indeterminate` when not `allSelected`. */
	someSelected: boolean;
	/** The cap is reached; additions are refused. Render a VISIBLE message (§2.14). */
	atMax: boolean;
};

/**
 * Additions stop at the cap, in visual order. Already-selected ids never count
 * against it twice.
 */
function withAdded(current: ReadonlySet<string>, add: readonly string[], max: number): ReadonlySet<string> {
	const next = new Set(current);
	for (const id of add) {
		if (next.has(id)) continue;
		if (next.size >= max) break;
		next.add(id);
	}
	return next;
}

/**
 * @param ids every SELECTABLE id on the page, in visual order. A row the user
 * may not select is simply not in this array — MEASURED consequence of getting
 * that wrong: `selectAll()` checks its checkbox, and because that checkbox is
 * `disabled` the user can never uncheck it again. `selectRange` walks this array
 * too, so an excluded row is also skipped by a shift-click that spans it.
 */
export function useTableSelection(ids: readonly string[], options?: { max?: number }): TableSelection {
	const max = options?.max ?? Number.POSITIVE_INFINITY;
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	// The shift-click anchor: the last row the user touched directly. A ref, not
	// state — moving it must never re-render, and every read happens inside an
	// event handler.
	const anchor = useRef<string | null>(null);

	// ponytail: ids are NOT pruned from the set when the page changes. Selection
	// deliberately survives pagination (the reference behaves the same way);
	// `clear()` is the reset. Prune here if a screen ever needs page-local counts.

	function selectRange(fromId: string, toId: string) {
		const from = ids.indexOf(fromId);
		const to = ids.indexOf(toId);
		if (from === -1 || to === -1) return;
		const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
		anchor.current = toId;
		setSelected((current) => withAdded(current, range, max));
	}

	return {
		selected,
		has: (id) => selected.has(id),

		toggle: (id, extend = false) => {
			if (extend && anchor.current !== null && anchor.current !== id) {
				selectRange(anchor.current, id);
				return;
			}
			anchor.current = id;
			setSelected((current) => {
				if (!current.has(id)) return withAdded(current, [id], max);
				const next = new Set(current);
				next.delete(id);
				return next;
			});
		},

		selectRange,

		selectAll: () => {
			setSelected((current) => withAdded(current, ids, max));
		},

		clear: () => {
			anchor.current = null;
			setSelected(new Set());
		},

		allSelected: ids.length > 0 && ids.every((id) => selected.has(id)),
		someSelected: selected.size > 0,
		atMax: selected.size >= max,
	};
}
