import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@/components/primitives/Table";
import { TableEmpty, TableNoResults } from "@/components/primitives/TableBlankState";
import { TableRowActions } from "@/components/primitives/TableRowActions";
import { TableSelectAllCell, TableSelectCell } from "@/components/primitives/TableSelectCell";
import { useTableSelection } from "@/hooks/useTableSelection";
import { type SortColumn, useTableSort } from "@/hooks/useTableSort";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The crossings — one behaviour per pair of E2 tickets, none of which any single
 * task could test because each owned only one side of it.
 *
 * Everything here is a real user path: sort a table you have selected rows in,
 * arrow into a row that has an action menu, render an empty list through the
 * windowing seam. Layout-dependent halves of the matrix (sticky under scroll,
 * arrowing across the window boundary) are NOT observable in jsdom and were
 * measured in a browser instead — `_design/CONVENTIONS.md` §2.18.
 */

type Run = { id: string; workflow: string; duration: number | null };

const RUNS: Run[] = [
	{ id: "run_c", workflow: "checkout", duration: 3 },
	{ id: "run_a", workflow: "billing", duration: 1 },
	{ id: "run_b", workflow: "alerts", duration: 2 },
];

const COLUMNS: SortColumn<Run, "workflow">[] = [{ key: "workflow", type: "alpha", value: (run) => run.workflow }];

function rowIds(): string[] {
	return Array.from(document.querySelectorAll("tbody tr"), (row) => row.getAttribute("data-run") ?? "");
}

/** Selection (issue 782) and sort (issue 779) over the same rows, wired as a screen wires them. */
function SortedSelectableTable() {
	const { sortedRows, getSortProps } = useTableSort(RUNS, COLUMNS);
	// The hook takes the ids in VISUAL order (§2.14), which is the SORTED order —
	// that is the whole reason this is passed `sortedRows` and not `RUNS`.
	const selection = useTableSelection(sortedRows.map((run) => run.id));
	return (
		<Table aria-label="Runs">
			<TableHeader>
				<TableRow>
					<TableSelectAllCell
						total={sortedRows.length}
						allSelected={selection.allSelected}
						someSelected={selection.someSelected}
						onToggleAll={() => (selection.allSelected ? selection.clear() : selection.selectAll())}
					/>
					<TableHeaderCell {...getSortProps("workflow")}>Workflow</TableHeaderCell>
				</TableRow>
			</TableHeader>
			<TableBody>
				{sortedRows.map((run) => (
					<TableRow key={run.id} data-run={run.id} isSelected={selection.has(run.id)}>
						<TableSelectCell
							rowLabel={run.id}
							checked={selection.has(run.id)}
							onToggle={(extend) => selection.toggle(run.id, extend)}
						/>
						<TableCell>{run.workflow}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

describe("selection × sort (issue 782 × issue 779)", () => {
	it("keeps the selection on the ROW when the table is re-sorted, not on the position", async () => {
		const user = userEvent.setup();
		render(<SortedSelectableTable />);
		expect(rowIds()).toEqual(["run_c", "run_a", "run_b"]);

		// Select the FIRST row, then re-sort so that position holds a different run.
		await user.click(screen.getByRole("checkbox", { name: "Select run_c" }));
		await user.click(screen.getByRole("button", { name: /^Workflow/ }));
		expect(rowIds()).toEqual(["run_b", "run_a", "run_c"]);

		// `useTableSelection` keys on the id, so the selection travelled with the
		// record. An index-keyed model would have moved it onto `run_b` here, which
		// is the classic version of this bug and is what this crossing exists to catch.
		expect(screen.getByRole("checkbox", { name: "Select run_c" })).toBeChecked();
		expect(screen.getByRole("checkbox", { name: "Select run_b" })).not.toBeChecked();
		expect(document.querySelector('tbody tr[data-selected="true"]')).toHaveAttribute("data-run", "run_c");
	});

	it("keeps select-all honest across a re-sort — the ids are the same set in a new order", async () => {
		const user = userEvent.setup();
		render(<SortedSelectableTable />);

		await user.click(screen.getByRole<HTMLInputElement>("checkbox", { name: "Select all 3 rows" }));
		await user.click(screen.getByRole("button", { name: /^Workflow/ }));

		// Re-sorting hands the hook a REORDERED `ids` array. `allSelected` is an
		// every() over that array, so it must stay true — a stale-order model would
		// flip the header checkbox back to indeterminate on a sort click.
		const selectAll = screen.getByRole<HTMLInputElement>("checkbox", { name: "Select all 3 rows" });
		expect(selectAll.checked).toBe(true);
		expect(selectAll.indeterminate).toBe(false);
	});
});

/**
 * Row actions (issue 781) inside rows that arrow-navigate (issue 780).
 *
 * `run_a`'s action cell is written BEFORE its link, and that is deliberate: with
 * the natural layout the record link is already the first focusable in the row,
 * so DOM order alone answers "does the action trigger steal the destination?"
 * and no test can tell `rowFocusTarget`'s link-first preference from a plain
 * first-focusable scan. Reversed, the two disagree — which is the only shape in
 * which this crossing is checkable at all.
 */
function ActionableTable() {
	return (
		<Table aria-label="Runs">
			<TableBody>
				{RUNS.map((run) => {
					const link = (
						<TableCell key="link">
							<a href={`/runs/${run.id}`}>{run.id}</a>
						</TableCell>
					);
					const actions = (
						<TableRowActions key="actions" rowLabel={run.id} items={[{ label: "Replay", onSelect: vi.fn() }]} />
					);
					return (
						<TableRow key={run.id} data-run={run.id}>
							{run.id === "run_a" ? [actions, link] : [link, actions]}
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

describe("row actions × keyboard nav (issue 781 × issue 780)", () => {
	it("does not let the action trigger steal the row's arrow-key destination", async () => {
		const user = userEvent.setup();
		render(<ActionableTable />);

		await user.tab();
		expect(screen.getByRole("link", { name: "run_c" })).toHaveFocus();
		await user.keyboard("{ArrowDown}");

		// `run_a`'s action trigger is the first focusable in its row, so a plain
		// first-focusable scan lands there. `rowFocusTarget` prefers the first
		// ordinary link, so the arrow reaches the RECORD — which is what a row-level
		// arrow key means. Drop that preference and this lands on a menu button.
		expect(screen.getByRole("link", { name: "run_a" })).toHaveFocus();
		expect(screen.getByRole("button", { name: "Actions for run_a" })).not.toHaveFocus();
	});

	it("yields ArrowDown to the action menu, and does NOT also move the row focus", async () => {
		const user = userEvent.setup();
		render(<ActionableTable />);

		screen.getByRole("button", { name: "Actions for run_c" }).focus();
		await user.keyboard("{ArrowDown}");

		// A Radix menu trigger opens on ArrowDown — the APG menu-button pattern, and
		// the right behaviour for the control the user is standing on. The crossing
		// that had to be checked is that `moveRowFocus` does not ALSO step a row,
		// which would open a menu on `run_c` while focus flew to `run_a`.
		//
		// Honest note on what holds it: NOT `moveRowFocus`'s `defaultPrevented` bail.
		// Deleting that line leaves this green, because Radix pulls focus into the
		// open menu afterwards regardless. The outcome is what is asserted, and the
		// opt-out line is guarded directly in `Table.test.tsx` instead.
		//
		// Queried through the DOM, not `getByRole`: an open Radix menu is modal and
		// `aria-hidden`s the rest of the page, so the row links leave the a11y tree.
		expect(await screen.findByRole("menuitem", { name: "Replay" })).toBeInTheDocument();
		for (const link of document.querySelectorAll("tbody a")) expect(link).not.toHaveFocus();
	});

	it("keeps the trigger a permanent tab stop, so its own focus-visible reveal can fire", async () => {
		const user = userEvent.setup();
		render(<ActionableTable />);

		await user.tab();
		await user.tab();
		// Tab order inside one row: link, then action trigger. If the reveal were
		// `hidden`/`display:none` (the reference's bug) this second Tab would skip
		// the row entirely and land on the next row's link.
		expect(screen.getByRole("button", { name: "Actions for run_c" })).toHaveFocus();
	});
});

describe("blank state × the windowing seam (issue 784 × issue 783)", () => {
	it("renders the blank state through rows + renderRow, which the two branches used to forbid", () => {
		render(
			<Table aria-label="Runs">
				<TableHeader>
					<TableRow>
						<TableHeaderCell>Run</TableHeaderCell>
					</TableRow>
				</TableHeader>
				<TableBody rows={[] as Run[]} renderRow={(run) => <TableRow key={run.id} />}>
					<TableEmpty icon={<Inbox aria-hidden="true" />} title="No runs yet" description="none" />
				</TableBody>
			</Table>,
		);
		// Before the integration fix this did not compile at all — `children` was
		// `never` in the rows branch, so a screen on the windowing seam had to branch
		// on <TableBody> itself and §2.13's "the blank row lives INSIDE the body"
		// was unreachable for exactly the tables that need windowing.
		expect(screen.getByRole("heading", { level: 3, name: "No runs yet" })).toBeInTheDocument();
		// The header survives the empty state — the entire point of putting the row inside.
		expect(screen.getByRole("columnheader", { name: "Run" })).toBeInTheDocument();
	});

	it("ignores the fallback the moment there are rows", () => {
		render(
			<Table aria-label="Runs">
				<TableBody rows={RUNS} renderRow={(run) => <TableRow key={run.id} data-run={run.id} />}>
					<TableNoResults />
				</TableBody>
			</Table>,
		);
		expect(rowIds()).toEqual(["run_c", "run_a", "run_b"]);
		expect(screen.queryByRole("heading", { name: "No matching results" })).not.toBeInTheDocument();
	});
});

describe("selection × windowing (issue 782 × issue 783)", () => {
	const VIEWPORT = 320;
	// The virtualizer measures the scroll container with `offsetHeight`, and jsdom
	// reports 0 for it — unstubbed, a windowed table renders no rows at all
	// (§2.16 rule 2's second note).
	beforeEach(() => void vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(VIEWPORT));
	afterEach(() => vi.restoreAllMocks());

	const MANY: Run[] = Array.from({ length: 150 }, (_, i) => ({
		id: `run_${String(i).padStart(3, "0")}`,
		workflow: "checkout",
		duration: i,
	}));

	function WindowedSelectable() {
		const selection = useTableSelection(MANY.map((run) => run.id));
		return (
			<Table aria-label="Runs" containerClassName="max-h-64">
				<TableHeader>
					<TableRow>
						<TableSelectAllCell
							total={MANY.length}
							allSelected={selection.allSelected}
							someSelected={selection.someSelected}
							onToggleAll={() => (selection.allSelected ? selection.clear() : selection.selectAll())}
						/>
						<TableHeaderCell>Run</TableHeaderCell>
					</TableRow>
				</TableHeader>
				<TableBody
					rows={MANY}
					renderRow={(run) => (
						<TableRow key={run.id} data-run={run.id} isSelected={selection.has(run.id)}>
							<TableSelectCell
								rowLabel={run.id}
								checked={selection.has(run.id)}
								onToggle={(extend) => selection.toggle(run.id, extend)}
							/>
							<TableCell>{run.id}</TableCell>
						</TableRow>
					)}
				/>
			</Table>
		);
	}

	it("select-all covers every record, not just the mounted window", async () => {
		const user = userEvent.setup();
		render(<WindowedSelectable />);
		// Windowed: the DOM holds a few dozen rows out of 150.
		expect(document.querySelectorAll("tbody tr").length).toBeLessThan(40);

		await user.click(screen.getByRole("checkbox", { name: "Select all 150 rows" }));

		// The hook's `ids` are the DATA, never the DOM — so select-all means all 150.
		// A DOM-derived selection (the reference's ref array over rendered checkboxes)
		// would silently select only what happened to be mounted.
		const selectAll = screen.getByRole<HTMLInputElement>("checkbox", { name: "Select all 150 rows" });
		expect(selectAll.checked).toBe(true);
		expect(selectAll.indeterminate).toBe(false);
		for (const row of document.querySelectorAll("tbody tr[data-run]")) {
			expect(row).toHaveAttribute("data-selected", "true");
		}
	});

	it("carries data-selected onto rows the window mounts later", async () => {
		const user = userEvent.setup();
		render(<WindowedSelectable />);

		await user.click(screen.getByRole("checkbox", { name: "Select run_002" }));
		expect(document.querySelector('tbody tr[data-run="run_002"]')).toHaveAttribute("data-selected", "true");
		// `renderRow` is called per mounted row with the row's own data, so selection
		// paint is recomputed on remount rather than cached at first render.
		expect(document.querySelector('tbody tr[data-run="run_003"]')).not.toHaveAttribute("data-selected");
	});
});
