import { cn } from "@/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

/**
 * The table substrate. Owned by E2-T1 and by the sequenced Wave-C tasks
 * after that — `_design/CONVENTIONS.md` §2.13 forbids E2-T4, E2-T5 and E2-T7 from
 * editing this file at all. Every slot they need is already exported here.
 *
 * Adapted from trigger.dev's `primitives/Table.tsx`, NOT transliterated:
 *   - their single `variant` key fuses density + surface + font family (§2.10
 *     is the rule that exists to prevent exactly that). Here scale is `density`
 *     (§2.11) and surface is fixed (§2.12).
 *   - React 19: no `forwardRef` anywhere; `ComponentPropsWithRef` carries `ref`
 *     (§2.8). Their ten exports are all `forwardRef`.
 *   - no `@tanstack/react-router` import and no `to` prop on `TableCell`. Row
 *     navigation is the caller's, which is why `/catalog/table` needs no
 *     router gate (§7.3).
 *   - hover/selected paint on the `<tr>`, not per cell — that is what lets a
 *     sticky cell say `bg-inherit` and track row state for free (§2.12).
 */

export type TableDensity = "compact" | "default" | "comfortable";

/**
 * The row heights of §2.11 as DATA, because `estimateSize()` needs an integer
 * (E2-T6) and E16-T5's density toggle may want to read them. Kept honest against
 * `TABLE_DENSITY_CLASSES` by a drift guard in `Table.test.tsx`: change one
 * without the other and the suite fails.
 */
export const TABLE_ROW_HEIGHT: Record<TableDensity, number> = { compact: 28, default: 40, comfortable: 44 };

/**
 * §2.11's ladder. The row height is `h-*` on the `<td>` — never `py-*`, which is
 * how six Studio screens ended up with six row heights and is not a number you
 * can hand to `estimateSize`. `height` on a cell is a MINIMUM, so taller content
 * still grows the row.
 *
 * Header text does not scale: it is `text-xs` uppercase dimmed at every density
 * (§2.11), a deliberate divergence from the reference, whose header is larger
 * and brighter than its data.
 *
 * Exported for the drift guard and for slot components in other files that need
 * to size themselves to the current density.
 */
export const TABLE_DENSITY_CLASSES = {
	compact: { td: "h-7 px-2 align-middle", th: "h-7 px-2", text: "text-xs" },
	default: { td: "h-10 px-3 align-middle", th: "h-8 px-3", text: "text-sm" },
	comfortable: { td: "h-11 px-4 align-middle", th: "h-9 px-4", text: "text-sm" },
} as const satisfies Record<TableDensity, { td: string; th: string; text: string }>;

const alignments = { left: "text-left", center: "text-center", right: "text-right" } as const;
type Alignment = keyof typeof alignments;

/**
 * §2.16 rule 2 — the windowing gate, and it is not an optimisation. Below it the
 * virtualizer's `count` is 0, so it measures nothing and the plain path runs:
 * `src/__tests__/setup.ts` has no `ResizeObserver` polyfill, so a table that
 * windows unconditionally renders ZERO rows under jsdom. `StepRail.tsx` gates
 * the same way for the same reason. 100 rows × 40px ≈ 4 viewports.
 *
 * **Every `/catalog/*` demo must stay under this**, or the frozen
 * `catalog.test.tsx` — which renders every page — starts windowing in jsdom.
 */
const VIRTUALIZE_THRESHOLD = 100;

/**
 * How far past the viewport to render. It also absorbs the one approximation in
 * here: the virtualizer measures the CONTAINER, so it thinks the rows start at
 * scroll offset 0 when they actually start below the `<thead>` (28-36px, §2.11).
 * `scrollMargin` is the exact fix and costs a layout read in an effect; 8 rows of
 * overscan is ≥ 224px against a ≤ 36px error, so the cheap version is correct in
 * practice. ponytail: revisit only if a header ever gets taller than the overscan.
 */
const OVERSCAN = 8;

// One context. `stickyHeader` has to reach `<thead>`, density has to reach every
// cell (§2.10 rule 9 forbids prop-drilling either) — and E2-T6 adds two more:
// the scroll element the virtualizer measures, and the way the row count
// `TableBody` computes gets back up to the `<table>` that must publish it as
// `aria-rowcount` (§2.16's corrected blast radius).
type TableContextValue = {
	density: TableDensity;
	stickyHeader: boolean;
	/** `undefined` = the DOM holds every row, so the table publishes no count. */
	setRowCount: (count: number | undefined) => void;
};
const TableContext = createContext<TableContextValue>({
	density: "default",
	stickyHeader: false,
	setRowCount: () => {},
});

/**
 * True inside `<TableHeader>`. `TableRow` is the ONLY row component — the caller
 * writes `<TableRow>` in `<thead>` and in `<tbody>` alike — so without this flag
 * the header row ships `group/row` and `hover:bg-hover` and hovers like a data
 * row (measured: header background 17,17,19 → 31,31,35). Worse, a slot component
 * hanging `group-hover/row:` off the row (§2.15 rule 7) would then reveal from
 * the header, which is where the select-all cell lives.
 *
 * A flag rather than a separate `TableHeaderRow` export: the caller cannot forget
 * to use it, and no existing markup changes.
 */
const TableInHeaderContext = createContext(false);

/** The read path for density from any descendant, including one in another file. */
export function useTableDensity(): TableDensity {
	return useContext(TableContext).density;
}

type TableProps = React.ComponentPropsWithRef<"table"> & {
	density?: TableDensity;
	/**
	 * Stick the `<thead>` to the table's OWN scroll container. The container is
	 * always `overflow-auto` — unlike the reference, Blok never hands scrolling
	 * to an unnamed ancestor (§2.12 rule 6).
	 *
	 * REQUIRES the caller to bound the container's height via
	 * `containerClassName` (e.g. `max-h-[60vh]`). An unbounded container never
	 * scrolls, so the header never sticks and this prop silently does nothing.
	 */
	stickyHeader?: boolean;
	/**
	 * The scroll container. Bound the height here — it is what `stickyHeader`
	 * sticks to AND what windowing (§2.16) measures. An unbounded container
	 * never scrolls, so it reports the full content height and every row renders:
	 * correct, but unwindowed.
	 */
	containerClassName?: string;
};

export function Table({
	className,
	containerClassName,
	density = "default",
	stickyHeader = false,
	...props
}: TableProps) {
	// The row count travels UP from `TableBody`, because `aria-rowcount` belongs on the
	// `<table>` while only `TableBody` knows how many rows there are and whether
	// the 100-row gate tripped. Set only while windowing: with every row in the
	// DOM the DOM is already the truth and the attribute is a second place to be
	// wrong (§2.15 rule 8).
	const [rowCount, setRowCount] = useState<number>();
	return (
		<TableContext.Provider value={{ density, stickyHeader, setRowCount }}>
			{/* `data-table-scroll` is how `TableBody` finds the element the virtualizer
			    must measure (§2.16). A DOM lookup rather than a ref on the context: a
			    parent's ref is attached only AFTER its children's layout effects have
			    run, so the virtualizer's first look would find null and the first paint
			    would be an empty table. */}
			<div
				data-table-scroll="true"
				className={cn("overflow-auto rounded-md border border-line bg-raised", containerClassName)}
			>
				{/* `data-density` is the handle for tests and for E16-T5's toggle. */}
				{/* `aria-rowcount` is BEFORE the spread on purpose: a caller that knows a
				    total the table cannot (a server-side count) overrides the local one. */}
				<table aria-rowcount={rowCount} className={cn("w-full", className)} data-density={density} {...props} />
			</div>
		</TableContext.Provider>
	);
}

export function TableHeader({ className, ...props }: React.ComponentPropsWithRef<"thead">) {
	const { stickyHeader } = useContext(TableContext);
	return (
		<TableInHeaderContext.Provider value={true}>
			<thead
				className={cn(
					"bg-raised",
					// The hairline is an `after:` pseudo-element, NOT `border-b`: Preflight
					// sets `border-collapse: collapse`, and under the collapsed model the
					// border belongs to the merged grid, so it does not travel with the
					// scrolled `<thead>` (§2.12 rule 8). `sticky` is a positioned value, so
					// it is the containing block for the absolute pseudo-element.
					stickyHeader && "sticky top-0 z-20 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-line",
					className,
				)}
				{...props}
			/>
		</TableInHeaderContext.Provider>
	);
}

/**
 * The virtualization seam (§2.16), FILLED IN by E2-T6 (issue 783). `rows` +
 * `renderRow` is the alternative to `children`; past `VIRTUALIZE_THRESHOLD` rows
 * this body renders a window of them between two spacer `<tr>`s instead of all
 * of them. **No caller changed, no `renderRow` changed, no file outside this one
 * changed** — which was the promise that actually held (§2.16's correction).
 *
 * `renderRow` MUST return an element carrying a stable `key` — this calls
 * `rows.map(renderRow)` and adds no key of its own.
 */
type TableBodyProps<T> = Omit<React.ComponentPropsWithRef<"tbody">, "children"> &
	(
		| { children: ReactNode; rows?: never; renderRow?: never }
		| { rows: readonly T[]; renderRow: (row: T, index: number) => ReactNode; children?: never }
	);

/**
 * Anything a Tab press can reach. `[tabindex="-1"]` is excluded on purpose: per
 * §2.15 rule 3 that value marks a REDUNDANT control (a second link to where the
 * row already goes), so it is never an arrow-key destination either.
 */
const FOCUSABLE = ':is(a[href],button,input,select,textarea,[tabindex]):not([tabindex="-1"]):not(:disabled)';

/**
 * Controls whose own behaviour is bound to ↑/↓ — a `<select>` changes value, a
 * textarea moves the caret. Row navigation must not steal those. A checkbox and
 * a radio are deliberately NOT here: neither does anything with an arrow key, so
 * E2-T5's selection column arrows onward like everything else.
 */
const OWNS_ARROW_KEYS =
	'textarea,select,[contenteditable="true"],input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])';

/**
 * The row's arrow-key destination, in priority order (E2-T3, issue 780):
 *
 * 1. `data-row-primary` — the explicit marker, when a row's primary link is not
 *    its first one. This is the whole caller-facing API: one attribute, no prop,
 *    no registration, and it survives E2-T6's windowing because it is read from
 *    the DOM at keypress time rather than from a ref array collected at render
 *    (the reference's `navigateCheckboxes` is such an array, with an
 *    acknowledged off-by-one).
 * 2. the first ordinary link — a row's primary affordance is a link to the
 *    record, and §2.15 rule 3 makes every redundant one `tabIndex={-1}`, which
 *    `FOCUSABLE` already excludes.
 * 3. any focusable control — so a row of buttons still navigates.
 *
 * `null` (a blank row, one of E2-T6's spacer rows) means "keep looking in the
 * same direction", not "stop".
 */
function rowFocusTarget(row: Element): HTMLElement | null {
	return (
		row.querySelector<HTMLElement>("[data-row-primary]") ??
		row.querySelector<HTMLElement>(`a[href]:not([tabindex="-1"])`) ??
		row.querySelector<HTMLElement>(FOCUSABLE)
	);
}

/**
 * ↑/↓ between rows, delegated on `<tbody>` so it costs one listener and works
 * for rows the caller composed, rows `renderRow` produced and rows E2-T6 has not
 * mounted yet alike.
 *
 * **It is a progressive enhancement layered on Tab, never a roving tabindex**
 * (§2.15 rule 3): no `<tr>` is focusable, no element's `tabIndex` is rewritten,
 * every control in every row keeps its ordinary tab stop. A roving model would
 * imply `role="grid"` and full 2-D cell navigation, which rule 1 bans — and it
 * would silently delete the tab stops rule 7 requires for row actions.
 *
 * The reference has no row-level arrow navigation at all; its arrows walk the
 * selection checkboxes only, and only when selection is enabled.
 */
function moveRowFocus(event: React.KeyboardEvent<HTMLTableSectionElement>) {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	// A modifier means the user asked the browser or the OS for something else
	// (Alt+↓ opens a select, Cmd+↓ jumps to the document end).
	if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

	const from = event.target as HTMLElement;
	if (from.matches(OWNS_ARROW_KEYS)) return;

	const body = event.currentTarget;
	const row = from.closest("tr");
	// Only rows of THIS body: a nested table inside a cell owns its own rows.
	if (!row || row.parentElement !== body) return;

	const rows = Array.from(body.children);
	const step = event.key === "ArrowDown" ? 1 : -1;
	for (let i = rows.indexOf(row) + step; i >= 0 && i < rows.length; i += step) {
		const candidate = rows[i];
		const target = candidate && rowFocusTarget(candidate);
		if (!target) continue;
		// Only now — an arrow at the last row must still scroll the page rather
		// than being swallowed by a handler that did nothing.
		event.preventDefault();
		target.focus();
		return;
	}
}

/**
 * §2.16 rule 1 — the window, between two spacer `<tr>`s, NEVER absolute
 * positioning.
 *
 * The reason is structural, not stylistic. You cannot put a translated `<div>`
 * inside `<tbody>`: it stops the element being a real `<table>`, which kills
 * `<th scope="col">` semantics and kills the sticky `<thead>` (which sticks to
 * the scroll container, not to the rows). The reference's `TreeView` uses the
 * two-div sandwich precisely BECAUSE it is not a table; that technique does not
 * transfer.
 *
 * The spacers are `aria-hidden` and carry no `aria-rowindex` (§2.15 rule 8).
 * They hold nothing focusable, so E2-T3's ↑/↓ steps over them for free — the
 * same path a `TableBlankRow` already takes. Their inline `style` is a computed
 * pixel height, not a color: deliberately outside the token guard's remit.
 *
 * `tabIndex={-1}` on them is NOT decoration and NOT a §2.15 rule 3 violation.
 * Biome classes a `<tr>` as an interactive element, so a bare
 * `aria-hidden="true"` there trips `a11y/noAriaHiddenOnFocusable`, and §9 forbids
 * suppressing an a11y rule. `tabIndex={-1}` is that rule's own documented remedy
 * — the element is hidden AND unreachable. It adds no tab stop, and E2-T3's
 * `FOCUSABLE` selector already excludes `[tabindex="-1"]`, so arrow navigation
 * still steps over a spacer instead of landing on it. (Writing `aria-hidden`
 * bare also passes, because the rule only matches the literal string "true" —
 * that is a hole in the matcher, not a remedy, so it is not what is used here.)
 *
 * `aria-rowindex` is cloned ONTO what `renderRow` returned rather than passed to
 * it, so the caller's `renderRow` signature is untouched and every existing one
 * keeps working. `TableRow` spreads its props, and `Table.test.tsx` guards that
 * spread. `cloneElement` preserves the element's own key.
 */
function windowRows<T>(
	rows: readonly T[],
	renderRow: (row: T, index: number) => ReactNode,
	items: { index: number; start: number; end: number }[],
	totalSize: number,
) {
	const paddingTop = items[0]?.start ?? 0;
	const paddingBottom = totalSize - (items[items.length - 1]?.end ?? 0);
	return (
		<>
			<tr aria-hidden="true" tabIndex={-1} style={{ height: paddingTop }} />
			{items.map((item) => {
				const row = rows[item.index];
				if (row === undefined) return null;
				const rendered = renderRow(row, item.index);
				// The header is row 1, so data row i (0-based) is i + 2. Off-by-one here
				// is the standard bug; it is asserted against the absolute index, not
				// against the position in the window.
				return isValidElement(rendered)
					? cloneElement(rendered as ReactElement<{ "aria-rowindex"?: number }>, { "aria-rowindex": item.index + 2 })
					: rendered;
			})}
			<tr aria-hidden="true" tabIndex={-1} style={{ height: paddingBottom }} />
		</>
	);
}

export function TableBody<T>({ className, children, rows, renderRow, onKeyDown, ref, ...props }: TableBodyProps<T>) {
	const { density, setRowCount } = useContext(TableContext);
	// This body's own element, which React attaches BEFORE this component's layout
	// effects — unlike the container's, which belongs to an ancestor. That ordering
	// is the whole reason the scroll element is found from here rather than passed
	// down: the virtualizer reads `getScrollElement()` in a layout effect, so a
	// container ref would still be null then and the first paint would show no rows.
	const bodyRef = useRef<HTMLTableSectionElement | null>(null);
	const useVirtual = rows !== undefined && rows.length >= VIRTUALIZE_THRESHOLD;

	const virtualizer = useVirtualizer({
		// The gate lives in `count`, exactly as in `StepRail.tsx`: at 0 the
		// virtualizer measures nothing and needs no `ResizeObserver`.
		count: useVirtual && rows ? rows.length : 0,
		// `closest` also does the right thing for a table nested inside a cell: it
		// finds that table's own container, not the outer one.
		getScrollElement: () => bodyRef.current?.closest<HTMLElement>("[data-table-scroll]") ?? null,
		// §2.11's ladder as an integer — the second reason the row height is a fixed
		// `h-*` and not derived padding. `h-*` is a MINIMUM, so a row with wrapping
		// content is taller than this and the scrollbar drifts; rows are re-measured
		// only if a caller opts in, which none does. ponytail: keep cell content on
		// one line. Attaching `measureElement` would mean cloning a ref onto the
		// caller's element and clobbering any ref it already set.
		estimateSize: () => TABLE_ROW_HEIGHT[density],
		overscan: OVERSCAN,
	});

	// §2.15 rule 8: data rows + 1 for the header, and ONLY while the DOM is
	// incomplete. Published by `<Table>`, which owns the `<table>` element.
	const rowCount = useVirtual && rows ? rows.length + 1 : undefined;
	useEffect(() => {
		setRowCount(rowCount);
		return () => setRowCount(undefined);
	}, [rowCount, setRowCount]);

	const items = virtualizer.getVirtualItems();

	return (
		// `relative` is load-bearing: E2-T7's loading overlay positions against it.
		<tbody
			ref={(node) => {
				bodyRef.current = node;
				// Compose rather than replace: `ref` rides `ComponentPropsWithRef<"tbody">`,
				// so a caller may already have one. Returning theirs preserves React 19's
				// ref-cleanup contract.
				if (typeof ref === "function") return ref(node);
				if (ref) ref.current = node;
			}}
			className={cn("relative", className)}
			// The caller's handler runs FIRST and can opt out by calling
			// `preventDefault()`; spreading `props` over this one would have dropped
			// row navigation the moment a caller wanted a key of its own.
			onKeyDown={(event) => {
				onKeyDown?.(event);
				moveRowFocus(event);
			}}
			{...props}
		>
			{/*
			 * Destructuring a union breaks TS narrowing, so both halves are tested —
			 * `rows &&` alone would leave `renderRow` possibly undefined.
			 */}
			{rows && renderRow
				? useVirtual
					? windowRows(rows, renderRow, items, virtualizer.getTotalSize())
					: rows.map(renderRow)
				: children}
		</tbody>
	);
}

type TableRowProps = React.ComponentPropsWithRef<"tr"> & {
	/** Presentational only. `<Table>` never owns selection (§2.14). */
	isSelected?: boolean;
};

/**
 * There is deliberately NO `disabled` prop (§2.13). A `<tr>` is a container, not
 * a control: the earlier `aria-disabled` + `opacity-50` + `pointer-events-none`
 * recipe told assistive tech the row was unavailable while every button inside it
 * stayed in the tab order and fired on Enter — §2.6's "aria-disabled alone is not
 * a disabled state". Disable the CONTROLS in the row, which are natively
 * disable-able. See the `at-ts-expect-error` guard in `Table.test.tsx`.
 */
export function TableRow({ className, isSelected = false, ...props }: TableRowProps) {
	const inHeader = useContext(TableInHeaderContext);
	return (
		<tr
			// The styling and TESTING hook. Selection is conveyed to assistive tech
			// by the row's real checkbox, never by `aria-selected` (§2.15 rule 6).
			data-selected={isSelected ? "true" : undefined}
			className={cn(
				"border-b border-line bg-raised last:border-b-0",
				// `group/row` ships HERE because slot components in other files hang
				// `group-hover/row:` and `group-focus-within/row:` off it and cannot
				// add it later (§2.15 rule 7) — but NOT on the header row, or every
				// reveal fires from the header too, which is where the select-all cell
				// lives. The header is not a data row and must not hover like one
				// (measured before this flag existed: 17,17,19 → 31,31,35).
				//
				// `transition-[background-color]`, never `transition-colors`: Tailwind
				// v4 folds `outline-color` into that shortcut, so `.focus-ring` on a
				// descendant fades in from the element's own text color — the E1 defect,
				// and a hovered row is exactly the element that wants both.
				!inHeader && "group/row transition-[background-color]",
				// A ternary, not variant stacking: `hover:` and `data-[…]:` have equal
				// specificity, so which wins depends on Tailwind's emission order
				// (§2.12 rule 5). Both states are OPAQUE tokens (rule 4) — a `/10` wash
				// composites twice under a `bg-inherit` sticky cell.
				//
				// `has-[:focus-visible]` is the keyboard twin of `hover:` (E2-T3): the
				// row a keyboard user is standing in reads as clearly as the one under
				// the mouse, and the sticky cell's `bg-inherit` picks it up for free.
				// NOT `:focus-within`, which fires on a mouse click too — that is the
				// reference's bug (`group-has-[[tabindex='0']:focus]`, §2.15 rule 9).
				!inHeader && (isSelected ? "bg-control" : "hover:bg-hover has-[:focus-visible]:bg-hover"),
				className,
			)}
			{...props}
		/>
	);
}

type TableHeaderCellProps = React.ComponentPropsWithRef<"th"> & {
	align?: Alignment;
	/** Put the children in an `sr-only select-none` span — selection cells, action columns. */
	hiddenLabel?: boolean;
	/** Fully controlled. T1 ships the markup and `aria-sort`; E2-T2 owns the state. */
	sortDirection?: "asc" | "desc" | null;
	/** Presence makes the header a real `<button>`, and is what turns `aria-sort` on. */
	onSort?: () => void;
};

const SORT_ICON = { asc: ChevronUp, desc: ChevronDown } as const;
const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

/**
 * What the NEXT activation does, keyed by the current direction — the
 * three-state cycle of `useTableSort` (asc → desc → cleared), stated in words.
 *
 * It is appended to the visible column name in a screen-reader-only span (the
 * token guard reads class strings, so this sentence deliberately does not spell
 * that utility inside backticks) rather than
 * written into an `aria-label`: the label would REPLACE the visible text, and a
 * name that does not contain its own visible label fails WCAG 2.5.3. So a
 * screen-reader user hears "Duration, sort descending, button" — the column AND
 * what pressing it will do — while the reference says "Toggle sort, button" on
 * every column of every table (§2.15 rule 5).
 *
 * `aria-sort` on the `<th>` states the CURRENT direction; this states the next
 * one. Both are needed: `aria-sort` is not announced by every AT on focus, and
 * it never says what the control will do.
 */
const NEXT_SORT_ACTION = { none: "sort ascending", asc: "sort descending", desc: "clear sort" } as const;

export function TableHeaderCell({
	className,
	children,
	align = "left",
	hiddenLabel = false,
	sortDirection = null,
	onSort,
	...props
}: TableHeaderCellProps) {
	const { density } = useContext(TableContext);
	// `select-none` is REQUIRED, not stylistic: an `sr-only` twin stays selectable
	// and a mouse-drag copies both strings (§2.12 rule 11, enforced by tokens.test).
	const label = hiddenLabel ? <span className="sr-only select-none">{children}</span> : children;
	const SortIcon = sortDirection ? SORT_ICON[sortDirection] : ChevronsUpDown;

	return (
		<th
			scope="col"
			// Only sortable headers say anything; a non-sortable one sets nothing at
			// all, and at most one column may be non-`none` (§2.15 rule 4).
			aria-sort={onSort ? (sortDirection ? ARIA_SORT[sortDirection] : "none") : undefined}
			className={cn(
				TABLE_DENSITY_CLASSES[density].th,
				alignments[align],
				"text-xs font-medium uppercase tracking-wider text-ink-dimmed",
				className,
			)}
			{...props}
		>
			{onSort ? (
				// The WHOLE header is the button and its accessible name STARTS with the column
				// name — the W3C APG pattern, needing no `aria-label`. The reference's
				// `aria-label="Toggle sort"` on every column is banned (§2.15 rule 5),
				// as is its ~16px chevron-only hit target (WCAG 2.2 AA 2.5.8). Enter and
				// Space come free from the real `<button>`; the sr-only span below says
				// what the next press will DO, which `aria-sort` never states.
				<button
					type="button"
					onClick={onSort}
					className={cn(
						// `uppercase` is REPEATED from the `<th>` on purpose: the UA stylesheet
						// sets `text-transform: none` on `button`, which BEATS the inherited
						// value, so a sortable header rendered in title case next to uppercase
						// non-sortable ones. Measured live before this line existed:
						// `getComputedStyle(th).textTransform === "uppercase"` while
						// `getComputedStyle(button).textTransform === "none"` on all three
						// sortable columns. Invisible to jsdom and to the token guard (§2.11).
						"focus-ring inline-flex h-full w-full items-center gap-1 rounded-md uppercase hover:text-ink",
						align === "right" && "justify-end",
						align === "center" && "justify-center",
					)}
				>
					{label}
					{/* `select-none` on every `sr-only` span, or a mouse-drag over the
					    header copies the invisible string too (§2.12 rule 11). */}
					<span className="sr-only select-none">, {NEXT_SORT_ACTION[sortDirection ?? "none"]}</span>
					<SortIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
				</button>
			) : (
				label
			)}
		</th>
	);
}

type TableCellProps = React.ComponentPropsWithRef<"td"> & {
	align?: Alignment;
	/** Sticky right column — E2-T4's action cell. */
	isSticky?: boolean;
};

export function TableCell({ className, align = "left", isSticky = false, ...props }: TableCellProps) {
	const { density } = useContext(TableContext);
	return (
		<td
			className={cn(
				TABLE_DENSITY_CLASSES[density].td,
				TABLE_DENSITY_CLASSES[density].text,
				alignments[align],
				"text-ink",
				// `bg-inherit`, never its own token: `background-color: inherit`
				// resolves to the `<tr>`'s COMPUTED value, so the sticky column tracks
				// base/hover/selected with one class and no duplicated state table
				// (§2.12 rule 3). Its own token would occlude the row state; no
				// background at all lets scrolled content pass through it.
				isSticky && "sticky right-0 z-10 bg-inherit",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * The body slot for E2-T7's empty / no-results / loading states. It lives INSIDE
 * `<TableBody>` so the header, the column widths and the sticky behaviour
 * survive the empty→populated transition (§2.13).
 *
 * `colSpan` defaults to 1000: HTML clamps `colspan` at 1000 and the surplus
 * columns have zero width, so a blank row spans the table with no hand-counting.
 * The reference hand-counts `colSpan={showRegion ? 16 : 15}` in four places in
 * one file.
 */
export function TableBlankRow({
	className,
	children,
	colSpan = 1000,
	...props
}: React.ComponentPropsWithRef<"tr"> & { colSpan?: number }) {
	return (
		<tr className={className} {...props}>
			<td colSpan={colSpan} className="p-0">
				{children}
			</td>
		</tr>
	);
}
