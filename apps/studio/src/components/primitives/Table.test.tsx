import {
	TABLE_DENSITY_CLASSES,
	TABLE_ROW_HEIGHT,
	Table,
	TableBlankRow,
	TableBody,
	TableCell,
	TableHeader,
	TableHeaderCell,
	TableRow,
	useTableDensity,
} from "@/components/primitives/Table";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("Table", () => {
	it("renders a named table with its header and rows", () => {
		render(
			<Table aria-label="Recent runs">
				<TableHeader>
					<TableRow>
						<TableHeaderCell>Run</TableHeaderCell>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell>run_01H8Z3K9</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		// §2.15 rule 2: a table with no accessible name is announced as "table".
		expect(screen.getByRole("table", { name: "Recent runs" })).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Run" })).toBeInTheDocument();
		expect(screen.getByRole("cell", { name: "run_01H8Z3K9" })).toBeInTheDocument();
	});

	it("marks a selected row with data-selected, not aria-selected", () => {
		render(
			<Table aria-label="Runs">
				<TableBody>
					<TableRow isSelected>
						<TableCell>picked</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		const row = screen.getByRole("row");
		// §2.15 rule 6 / §8.3: a semantic signal, not a Tailwind class string.
		expect(row).toHaveAttribute("data-selected", "true");
		expect(row).not.toHaveAttribute("aria-selected");
	});

	it("makes a sortable header a real button named for its column", async () => {
		const onSort = vi.fn();
		render(
			<Table aria-label="Runs">
				<TableHeader>
					<TableRow>
						<TableHeaderCell sortDirection="asc" onSort={onSort}>
							Duration
						</TableHeaderCell>
						<TableHeaderCell>Status</TableHeaderCell>
					</TableRow>
				</TableHeader>
			</Table>,
		);
		expect(screen.getByRole("columnheader", { name: /Duration/ })).toHaveAttribute("aria-sort", "ascending");
		// A non-sortable header sets nothing at all (§2.15 rule 4).
		expect(screen.getByRole("columnheader", { name: "Status" })).not.toHaveAttribute("aria-sort");
		// The accessible name is the COLUMN, not "Toggle sort" (§2.15 rule 5).
		const button = screen.getByRole("button", { name: "Duration" });
		await userEvent.click(button);
		expect(onSort).toHaveBeenCalledOnce();
	});

	it("renders rows through the virtualization seam, and only when both halves are given", () => {
		const renderRow = vi.fn((row: { id: string }) => (
			<TableRow key={row.id}>
				<TableCell>{row.id}</TableCell>
			</TableRow>
		));
		const { rerender } = render(
			<Table aria-label="Runs">
				<TableBody rows={[{ id: "a" }, { id: "b" }]} renderRow={renderRow} />
			</Table>,
		);
		expect(screen.getAllByRole("row")).toHaveLength(2);
		expect(renderRow).toHaveBeenCalledTimes(2);

		renderRow.mockClear();
		rerender(
			<Table aria-label="Runs">
				<TableBody>
					<TableRow>
						<TableCell>literal child</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		expect(renderRow).not.toHaveBeenCalled();
		expect(screen.getAllByRole("row")).toHaveLength(1);
	});

	it("spans a blank row across the whole table without hand-counting columns", () => {
		render(
			<Table aria-label="Runs">
				<TableBody>
					<TableBlankRow>nothing here yet</TableBlankRow>
				</TableBody>
			</Table>,
		);
		// 1000 is HTML's clamp; surplus columns are zero-width (§2.13).
		expect(screen.getByRole("cell", { name: "nothing here yet" })).toHaveAttribute("colspan", "1000");
	});

	it("exposes density through context rather than a prop drill", () => {
		function Probe() {
			return <TableCell>{useTableDensity()}</TableCell>;
		}
		render(
			<Table aria-label="Runs" density="compact">
				<TableBody>
					<TableRow>
						<Probe />
					</TableRow>
				</TableBody>
			</Table>,
		);
		expect(screen.getByRole("table")).toHaveAttribute("data-density", "compact");
		expect(screen.getByRole("cell", { name: "compact" })).toBeInTheDocument();
	});

	// The one non-trivial invariant in this file. E2-T6 reads TABLE_ROW_HEIGHT for
	// `estimateSize` and E16-T5 may read it too, so the number and the class it is
	// supposed to describe must not drift apart. Edit either alone and this fails.
	it("keeps TABLE_ROW_HEIGHT and the density class table in lockstep (§2.11)", () => {
		for (const [density, height] of Object.entries(TABLE_ROW_HEIGHT)) {
			const td = TABLE_DENSITY_CLASSES[density as keyof typeof TABLE_DENSITY_CLASSES].td;
			const match = /(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/.exec(td);
			expect(match, `${density}: no fixed h-* on the <td> — a py-* row height is a review failure`).not.toBeNull();
			expect(Number(match?.[1]) * 4, `${density} row height`).toBe(height);
		}
		// And the map covers exactly the ladder, so a fourth density cannot be
		// added to one table only.
		expect(Object.keys(TABLE_ROW_HEIGHT).sort()).toEqual(Object.keys(TABLE_DENSITY_CLASSES).sort());
	});
});
