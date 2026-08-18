import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@/components/primitives/Table";
import { type SortColumn, type SortState, compareColumn, sortRows, useTableSort } from "@/hooks/useTableSort";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

type Run = { id: string; duration: number | null; workflow: string };

const RUNS: Run[] = [
	{ id: "a", duration: 3, workflow: "beta" },
	{ id: "b", duration: null, workflow: "Alpha" },
	{ id: "c", duration: 1, workflow: "alpha" },
];

const COLUMNS: SortColumn<Run, "duration" | "workflow">[] = [
	{ key: "duration", type: "number", value: (run) => run.duration },
	{ key: "workflow", type: "alpha", value: (run) => run.workflow },
];

const ids = (rows: readonly Run[]) => rows.map((run) => run.id).join("");

/** A table wired the way a real screen wires it, so the keyboard path is exercised for real. */
function SortableTable({
	sort,
	onSortChange,
}: {
	sort?: SortState<"duration" | "workflow"> | null;
	onSortChange?: (sort: SortState<"duration" | "workflow"> | null) => void;
}) {
	const { sortedRows, getSortProps } = useTableSort(RUNS, COLUMNS, { sort, onSortChange });
	return (
		<Table aria-label="Runs">
			<TableHeader>
				<TableRow>
					<TableHeaderCell {...getSortProps("duration")}>Duration</TableHeaderCell>
					<TableHeaderCell {...getSortProps("workflow")}>Workflow</TableHeaderCell>
					<TableHeaderCell>Status</TableHeaderCell>
				</TableRow>
			</TableHeader>
			<TableBody>
				{sortedRows.map((run) => (
					<TableRow key={run.id}>
						<TableCell>{run.id}</TableCell>
						<TableCell>{run.workflow}</TableCell>
						<TableCell>Completed</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/** The visible row order, read off the DOM rather than off the hook's return. */
const renderedIds = () =>
	screen
		.getAllByRole("row")
		.slice(1)
		.map((row) => row.querySelectorAll("td")[0]?.textContent)
		.join("");

describe("sortRows / compareColumn", () => {
	it("sorts numerically and alphabetically, ascending and descending", () => {
		const duration = COLUMNS[0] as SortColumn<Run, "duration">;
		const workflow = COLUMNS[1] as SortColumn<Run, "workflow">;
		expect(ids(sortRows(RUNS, duration, "asc"))).toBe("cab");
		expect(ids(sortRows(RUNS, duration, "desc"))).toBe("acb");
		// `sensitivity: "base"` — "Alpha" and "alpha" tie, so the incoming order (b, c) holds.
		expect(ids(sortRows(RUNS, workflow, "asc"))).toBe("bca");
		expect(ids(sortRows(RUNS, workflow, "desc"))).toBe("abc");
	});

	it("sorts missing values LAST in both directions", () => {
		const duration = COLUMNS[0] as SortColumn<Run, "duration">;
		// Row "b" has a null duration: it is last ascending AND last descending. A
		// sign applied to the null branch would float the unknowns to the top on
		// the second click.
		expect(ids(sortRows(RUNS, duration, "asc")).endsWith("b")).toBe(true);
		expect(ids(sortRows(RUNS, duration, "desc")).endsWith("b")).toBe(true);
		const empty: SortColumn<Run, "workflow"> = { key: "workflow", type: "alpha", value: () => "" };
		expect(compareColumn(empty, RUNS[0] as Run, RUNS[1] as Run, "asc")).toBe(0);
	});

	it("is stable: rows that tie keep their incoming order", () => {
		// The reason `sortRows` does not decorate with an index like the reference
		// does — `Array#sort` is spec-stable since ES2019. Delete the copy or swap
		// in an unstable algorithm and this flips.
		const tied: SortColumn<Run, "duration"> = { key: "duration", type: "number", value: () => 1 };
		expect(ids(sortRows(RUNS, tied, "asc"))).toBe("abc");
		expect(ids(sortRows(RUNS, tied, "desc"))).toBe("abc");
	});

	it("applies the direction flip on top of a custom comparator", () => {
		const custom: SortColumn<Run, "duration"> = {
			key: "duration",
			type: "custom",
			compare: (a, b) => a.id.localeCompare(b.id),
		};
		expect(ids(sortRows(RUNS, custom, "asc"))).toBe("abc");
		expect(ids(sortRows(RUNS, custom, "desc"))).toBe("cba");
	});

	it("leaves the rows untouched when the sorted key matches no column", () => {
		// A stale `?sort=` URL param from E3 must degrade to the incoming order,
		// not crash and not silently sort by something else.
		function Stale() {
			const { sortedRows } = useTableSort(RUNS, COLUMNS, { sort: { key: "duration", direction: "asc" } });
			return <span data-testid="order">{ids(sortedRows)}</span>;
		}
		const { rerender } = render(<Stale />);
		expect(screen.getByTestId("order")).toHaveTextContent("cab");
		function Unknown() {
			const { sortedRows } = useTableSort(RUNS, [], { sort: { key: "duration", direction: "asc" } });
			return <span data-testid="order">{ids(sortedRows)}</span>;
		}
		rerender(<Unknown />);
		expect(screen.getByTestId("order")).toHaveTextContent("abc");
	});
});

describe("useTableSort in a table", () => {
	it("cycles asc → desc → cleared from the keyboard, updating aria-sort and the button's name", async () => {
		const user = userEvent.setup();
		render(<SortableTable />);

		const header = () => screen.getByRole("columnheader", { name: /Duration/ });
		// Unsorted: `aria-sort="none"`, and the name says what a press will DO.
		expect(header()).toHaveAttribute("aria-sort", "none");
		expect(screen.getByRole("button", { name: "Duration, sort ascending" })).toBeInTheDocument();
		expect(renderedIds()).toBe("abc");

		// A REAL Tab, not `.focus()`: the header must be reachable in the natural order.
		await user.tab();
		expect(screen.getByRole("button", { name: /Duration/ })).toHaveFocus();

		await user.keyboard("{Enter}");
		expect(header()).toHaveAttribute("aria-sort", "ascending");
		expect(screen.getByRole("button", { name: "Duration, sort descending" })).toBeInTheDocument();
		expect(renderedIds()).toBe("cab");

		// Space, the other native button activation.
		await user.keyboard(" ");
		expect(header()).toHaveAttribute("aria-sort", "descending");
		expect(screen.getByRole("button", { name: "Duration, clear sort" })).toBeInTheDocument();
		expect(renderedIds()).toBe("acb");

		// Third press CLEARS, returning the incoming order — a server default is
		// reachable without a reload.
		await user.keyboard("{Enter}");
		expect(header()).toHaveAttribute("aria-sort", "none");
		expect(screen.getByRole("button", { name: "Duration, sort ascending" })).toBeInTheDocument();
		expect(renderedIds()).toBe("abc");
	});

	it("keeps at most one column sorted, and sets nothing at all on a non-sortable header", async () => {
		const user = userEvent.setup();
		render(<SortableTable />);
		await user.click(screen.getByRole("button", { name: /Duration/ }));
		await user.click(screen.getByRole("button", { name: /Workflow/ }));

		// §2.15 rule 4: at most one non-`none`, and the previous column resets to
		// `none` rather than keeping a stale arrow.
		expect(screen.getByRole("columnheader", { name: /Workflow/ })).toHaveAttribute("aria-sort", "ascending");
		expect(screen.getByRole("columnheader", { name: /Duration/ })).toHaveAttribute("aria-sort", "none");
		expect(screen.getByRole("columnheader", { name: "Status" })).not.toHaveAttribute("aria-sort");
		// A second column always starts at asc, never inherits the last direction.
		expect(renderedIds()).toBe("bca");
	});

	it("is controlled when `sort` is passed: the caller owns the state (E3's URL seam)", async () => {
		const user = userEvent.setup();
		const onSortChange = vi.fn();
		// `sort` pinned and never updated ⇒ the hook must not sort itself.
		render(<SortableTable sort={{ key: "duration", direction: "asc" }} onSortChange={onSortChange} />);
		expect(renderedIds()).toBe("cab");

		await user.click(screen.getByRole("button", { name: /Duration/ }));
		expect(onSortChange).toHaveBeenCalledWith({ key: "duration", direction: "desc" });
		// No local state leaked in behind the caller's back.
		expect(screen.getByRole("columnheader", { name: /Duration/ })).toHaveAttribute("aria-sort", "ascending");
		expect(renderedIds()).toBe("cab");

		// And with the caller feeding the state back, it advances normally.
		function Controlled() {
			const [sort, setSort] = useState<SortState<"duration" | "workflow"> | null>(null);
			return <SortableTable sort={sort} onSortChange={setSort} />;
		}
		render(<Controlled />);
		const [, second] = screen.getAllByRole("button", { name: /Duration/ });
		await user.click(second as HTMLElement);
		expect(screen.getAllByRole("columnheader", { name: /Duration/ })[1]).toHaveAttribute("aria-sort", "ascending");
	});
});
