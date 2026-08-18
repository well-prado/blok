import { Button } from "@/components/primitives/Buttons";
import { EmptyState } from "@/components/primitives/EmptyState";
import { Spinner } from "@/components/primitives/Spinner";
import { TableBlankRow } from "@/components/primitives/Table";
import { FilterX, SearchX } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The three blank bodies of `_design/CONVENTIONS.md` §2.13, owned by E2-T7.
 *
 * Each is a thin wrapper putting an `EmptyState` inside a `TableBlankRow`, so
 * the blank body lives INSIDE `<TableBody>` and the header, the column widths
 * and the sticky behaviour all survive the empty -> populated transition. Zero
 * edits to `Table.tsx` (§2.13 forbids them) and zero route changes — the §G.10
 * shim PR migrates callers after Wave C.
 *
 * `empty` and `no-results` are DIFFERENT components on purpose, because they are
 * different situations with different actions: "nothing has ever been here"
 * offers the action that creates the first record; "your filters excluded
 * everything" offers to clear the filters. A single component with a boolean
 * would make one of the two copies a lie.
 *
 * E2 owns the table-shaped presentation; E11-T4 owns the CONTENT. That is why
 * `TableEmpty` takes `EmptyState`'s whole prop bag (icon, title, description,
 * action, snippets, docLink) rather than hard-coding product copy, and why
 * `TableNoResults`' copy is all overridable defaults: E11 swaps copy, icons and
 * doc links with zero changes to any E2 file. There is no second empty-state
 * component here and `EmptyState` is not restyled.
 */

/** "Nothing has ever been here." The content is the caller's (E11-T4's). */
export function TableEmpty({ colSpan, ...emptyState }: React.ComponentProps<typeof EmptyState> & { colSpan?: number }) {
	return (
		<TableBlankRow colSpan={colSpan}>
			<EmptyState {...emptyState} />
		</TableBlankRow>
	);
}

type TableNoResultsProps = {
	/** Omit it and NO control renders — a "Clear filters" button that clears nothing is a lie (§2.6). */
	onClearFilters?: () => void;
	icon?: ReactNode;
	title?: string;
	description?: ReactNode;
	/** Pass the real column count when the table sets `table-layout: fixed` (§2.13's caveat). */
	colSpan?: number;
};

/**
 * "Your filters excluded everything." Distinct state, distinct copy, distinct
 * action — never "create the first record", which already exists somewhere
 * behind the filter.
 */
export function TableNoResults({
	onClearFilters,
	colSpan,
	icon = <SearchX aria-hidden="true" className="h-6 w-6" />,
	title = "No matching results",
	description = "No records match the filters you have applied.",
}: TableNoResultsProps) {
	return (
		<TableBlankRow colSpan={colSpan}>
			<EmptyState
				icon={icon}
				title={title}
				description={description}
				action={
					onClearFilters ? (
						// An ordinary `<Button>`: a real tab stop carrying `.focus-ring`, and
						// `disabled` on it would be the native attribute, never a lookalike.
						<Button variant="secondary" size="sm" onClick={onClearFilters} leadingIcon={<FilterX />}>
							Clear filters
						</Button>
					) : undefined
				}
			/>
		</TableBlankRow>
	);
}

/**
 * A fetch in flight over an existing shape: the rows stay, dimmed under an
 * overlay, so the table does not collapse and reflow on every refresh.
 *
 * `absolute inset-0` resolves against `<TableBody>`, which ships `relative` for
 * exactly this (§2.16). `Spinner` is an `<output>`, i.e. a live status region,
 * so the announcement is its `label`; the visible twin is `aria-hidden` to keep
 * it out of the accessible name.
 *
 * The INNER box is positioned too, and that is not decoration. An absolutely
 * positioned `<tr>` covers the body, but its `<td>` shrink-wraps out of table
 * layout — MEASURED on `/catalog/table-blank-states`: row 742 x 120.5, cell
 * 73.3 x 20 at the top-left corner, so `h-full` on the content resolved against
 * 20px and the spinner sat in the corner. Positioning the content against the
 * row instead (the row is `absolute`, so it is the containing block) measures
 * 742 x 120.5 with the content centred on the row's own centre.
 */
export function TableLoadingOverlay({ label = "Loading", colSpan }: { label?: string; colSpan?: number }) {
	return (
		<TableBlankRow colSpan={colSpan} className="absolute inset-0 bg-raised/80">
			<div className="absolute inset-0 flex items-center justify-center gap-2">
				<Spinner size="sm" label={label} />
				<span aria-hidden="true" className="text-sm text-ink-dimmed">
					{label}
				</span>
			</div>
		</TableBlankRow>
	);
}
