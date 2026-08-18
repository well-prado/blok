import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { createContext, useContext } from "react";
import type { ReactNode } from "react";

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

// One context, two values. `stickyHeader` has to reach `<thead>` and density has
// to reach every cell; §2.10 rule 9 forbids prop-drilling either.
type TableContextValue = { density: TableDensity; stickyHeader: boolean };
const TableContext = createContext<TableContextValue>({ density: "default", stickyHeader: false });

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
	/** The scroll container. Bound the height here. */
	containerClassName?: string;
};

export function Table({
	className,
	containerClassName,
	density = "default",
	stickyHeader = false,
	...props
}: TableProps) {
	return (
		<TableContext.Provider value={{ density, stickyHeader }}>
			<div className={cn("overflow-auto rounded-md border border-line bg-raised", containerClassName)}>
				{/* `data-density` is the handle for tests and for E16-T5's toggle. */}
				<table className={cn("w-full", className)} data-density={density} {...props} />
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
 * The virtualization seam (§2.16). `rows` + `renderRow` is the alternative to
 * `children`; E2-T6 replaces THAT ONE EXPRESSION with a windowed one and touches
 * nothing else in the codebase.
 *
 * `renderRow` MUST return an element carrying a stable `key` — this calls
 * `rows.map(renderRow)` and adds no key of its own.
 */
type TableBodyProps<T> = Omit<React.ComponentPropsWithRef<"tbody">, "children"> &
	(
		| { children: ReactNode; rows?: never; renderRow?: never }
		| { rows: readonly T[]; renderRow: (row: T, index: number) => ReactNode; children?: never }
	);

export function TableBody<T>({ className, children, rows, renderRow, ...props }: TableBodyProps<T>) {
	return (
		// `relative` is load-bearing: E2-T7's loading overlay positions against it.
		<tbody className={cn("relative", className)} {...props}>
			{/*
			 * Destructuring a union breaks TS narrowing, so both halves are tested —
			 * `rows &&` alone would leave `renderRow` possibly undefined.
			 */}
			{rows && renderRow ? rows.map(renderRow) : children}
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
				!inHeader && (isSelected ? "bg-control" : "hover:bg-hover"),
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
