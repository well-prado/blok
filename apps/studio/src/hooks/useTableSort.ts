import { useCallback, useMemo, useState } from "react";

/**
 * Single-column table sort. E2-T2 owns this file (CONVENTIONS §12.5).
 *
 * It lives in `src/hooks/`, not `components/primitives/`: a hook is not a
 * primitive (§2.14). `<TableHeaderCell sortDirection onSort>` stays purely
 * presentational and owns no state — this is the DEFAULT LOCAL owner of it, and
 * E3 (issue 789) replaces the state with URL-derived state at the CALL SITE, by
 * passing `sort` + `onSortChange`, touching no E2 file (§2.15, "Sort and filter
 * URL state").
 *
 * Semantics copied from trigger.dev's `useTableSort.ts`, which are good:
 * three-state cycle asc → desc → cleared, stable, nulls last in both
 * directions, `localeCompare` with `sensitivity: "base"` for text. The
 * comparator is exported as a pure function so ordering is unit-testable
 * without rendering.
 *
 * ponytail: single-column only, because that is what the ticket and the URL
 * contract (`?sort=<key>&dir=asc|desc`) describe. Multi-column sort would need
 * a different URL contract and a different `aria-sort` story (§2.15 rule 4
 * allows at most one non-`none` column) — a new ticket, not a flag here.
 */

export type SortDirection = "asc" | "desc";

export type SortState<K extends string = string> = { key: K; direction: SortDirection };

/**
 * A sortable column.
 *
 * - `number` — numeric order. `null` / `undefined` / `NaN` sort LAST in both directions.
 * - `alpha` — `localeCompare` with `sensitivity: "base"`, i.e. case- and accent-insensitive.
 *   Nullish and empty strings sort LAST in both directions.
 * - `custom` — your own ascending comparator; the direction flip is applied on top.
 */
export type SortColumn<T, K extends string = string> =
	| { key: K; type: "number"; value: (row: T) => number | null | undefined }
	| { key: K; type: "alpha"; value: (row: T) => string | null | undefined }
	| { key: K; type: "custom"; compare: (a: T, b: T) => number };

/** Presentational props to spread onto a `<TableHeaderCell>`. */
export type TableSortHeaderProps = { sortDirection: SortDirection | null; onSort: () => void };

/** Pure, so ordering is testable without rendering. */
export function compareColumn<T, K extends string>(
	column: SortColumn<T, K>,
	a: T,
	b: T,
	direction: SortDirection,
): number {
	const sign = direction === "asc" ? 1 : -1;

	if (column.type === "custom") return sign * column.compare(a, b);

	const av = column.value(a);
	const bv = column.value(b);
	// Missing values sort last in BOTH directions: the sign is deliberately not
	// applied here. A column of durations where half the runs are still going
	// must not put the unknowns on top just because you clicked twice.
	const aMissing = av === null || av === undefined || (column.type === "number" ? Number.isNaN(av) : av === "");
	const bMissing = bv === null || bv === undefined || (column.type === "number" ? Number.isNaN(bv) : bv === "");
	if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1;

	return column.type === "number"
		? sign * ((av as number) - (bv as number))
		: sign * (av as string).localeCompare(bv as string, undefined, { sensitivity: "base" });
}

/**
 * Stable sort by one column. Rows that compare equal keep their incoming order.
 *
 * ponytail: no index decoration. `Array.prototype.sort` has been REQUIRED to be
 * stable since ES2019, so the reference's decorate/sort/undecorate round trip
 * buys nothing here. Guarded by a test that ties three rows on the sort key and
 * asserts the incoming order survives.
 */
export function sortRows<T, K extends string>(
	rows: readonly T[],
	column: SortColumn<T, K>,
	direction: SortDirection,
): T[] {
	return [...rows].sort((a, b) => compareColumn(column, a, b, direction));
}

/** asc → desc → cleared, and any other column starts at asc. */
function nextSort<K extends string>(current: SortState<K> | null, key: K): SortState<K> | null {
	if (current?.key !== key) return { key, direction: "asc" };
	if (current.direction === "asc") return { key, direction: "desc" };
	return null;
}

type UseTableSortOptions<K extends string> = {
	/**
	 * Pass this — including as `null` — to CONTROL the sort. The hook then keeps
	 * no state of its own and every activation goes to `onSortChange`. Omit it
	 * entirely for local state. This is the seam E3 (issue 789) uses to move sort
	 * into the URL without touching this file.
	 */
	sort?: SortState<K> | null;
	/** Called with the next state on every activation, controlled or not. */
	onSortChange?: (sort: SortState<K> | null) => void;
};

export function useTableSort<T, K extends string = string>(
	rows: readonly T[],
	columns: readonly SortColumn<T, K>[],
	options?: UseTableSortOptions<K>,
): {
	sortedRows: readonly T[];
	sort: SortState<K> | null;
	/** `<TableHeaderCell {...getSortProps("duration")}>Duration</TableHeaderCell>` */
	getSortProps: (key: K) => TableSortHeaderProps;
} {
	const [localSort, setLocalSort] = useState<SortState<K> | null>(null);
	const isControlled = options?.sort !== undefined;
	const sort = isControlled ? (options?.sort ?? null) : localSort;
	const onSortChange = options?.onSortChange;

	const sortedRows = useMemo(() => {
		if (!sort) return rows;
		// ponytail: a linear find, not a Map. `columns` is nearly always an inline
		// literal with a fresh identity every render, so a memoised Map would be
		// rebuilt every render anyway — for a handful of columns.
		const column = columns.find((candidate) => candidate.key === sort.key);
		// An unknown key (a stale URL param, say) means "no sort", never a crash.
		return column ? sortRows(rows, column, sort.direction) : rows;
	}, [rows, columns, sort]);

	const getSortProps = useCallback(
		(key: K): TableSortHeaderProps => ({
			sortDirection: sort?.key === key ? sort.direction : null,
			onSort: () => {
				const next = nextSort(sort, key);
				if (!isControlled) setLocalSort(next);
				onSortChange?.(next);
			},
		}),
		[sort, isControlled, onSortChange],
	);

	return { sortedRows, sort, getSortProps };
}
