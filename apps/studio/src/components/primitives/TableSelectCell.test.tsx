import { Table, TableBody, TableHeader, TableRow } from "@/components/primitives/Table";
import { TableSelectAllCell, TableSelectCell } from "@/components/primitives/TableSelectCell";
import { useTableSelection } from "@/hooks/useTableSelection";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

function InTable({ children }: { children: ReactNode }) {
	return (
		<Table aria-label="Runs">
			<TableBody>
				<TableRow>{children}</TableRow>
			</TableBody>
		</Table>
	);
}

describe("TableSelectCell", () => {
	it("names the checkbox after its row", () => {
		render(
			<InTable>
				<TableSelectCell rowLabel="run_01H8Z3K9" checked={false} onToggle={vi.fn()} />
			</InTable>,
		);
		// The reference's row checkboxes announce as "checkbox, not checked" with no
		// row identity at all (§2.15 rule 6). `Checkbox`'s required `label` makes
		// that shape unrepresentable here.
		expect(screen.getByRole("checkbox", { name: "Select run_01H8Z3K9" })).not.toBeChecked();
	});

	it("is an ordinary tab stop and toggles on Space", async () => {
		const onToggle = vi.fn();
		const user = userEvent.setup();
		render(
			<InTable>
				<TableSelectCell rowLabel="run_a" checked={false} onToggle={onToggle} />
			</InTable>,
		);

		// §2.15 rule 3: the checkbox ships NO tabIndex — a real tab stop, which is
		// what lets a keyboard user reach the selection at all.
		await user.tab();
		expect(screen.getByRole("checkbox")).toHaveFocus();

		await user.keyboard(" ");
		expect(onToggle).toHaveBeenCalledWith(false);
	});

	it("reports shift-click as an extend, and a plain click as not", async () => {
		const onToggle = vi.fn();
		const user = userEvent.setup();
		render(
			<InTable>
				<TableSelectCell rowLabel="run_a" checked={false} onToggle={onToggle} />
			</InTable>,
		);
		const checkbox = screen.getByRole("checkbox");

		await user.click(checkbox);
		expect(onToggle).toHaveBeenLastCalledWith(false);

		await user.keyboard("{Shift>}");
		await user.click(checkbox);
		await user.keyboard("{/Shift}");
		expect(onToggle).toHaveBeenLastCalledWith(true);
	});

	it("does not fire when disabled", async () => {
		const onToggle = vi.fn();
		const user = userEvent.setup();
		render(
			<InTable>
				<TableSelectCell rowLabel="run_a" checked={false} onToggle={onToggle} disabled />
			</InTable>,
		);
		const checkbox = screen.getByRole("checkbox");
		expect(checkbox).toBeDisabled();
		await user.click(checkbox);
		expect(onToggle).not.toHaveBeenCalled();
	});
});

function InHeader({ children }: { children: ReactNode }) {
	return (
		<Table aria-label="Runs">
			<TableHeader>
				<TableRow>{children}</TableRow>
			</TableHeader>
		</Table>
	);
}

describe("TableSelectAllCell", () => {
	it("names itself with the row count and stays visible to assistive tech", () => {
		render(
			<InHeader>
				<TableSelectAllCell total={3} allSelected={false} someSelected={false} onToggleAll={vi.fn()} />
			</InHeader>,
		);
		// It must NOT go through `hiddenLabel`, which would put the control itself
		// inside an `sr-only` span. `toBeVisible()` CANNOT see that regression —
		// jsdom loads no stylesheet, so `sr-only` hides nothing there and the
		// assertion stayed green through the mutation. The structural check is the
		// guard: the input must have no `sr-only` ancestor.
		const checkbox = screen.getByRole("checkbox", { name: "Select all 3 rows" });
		expect(checkbox.closest(".sr-only")).toBeNull();
		expect(checkbox).not.toBeChecked();
	});

	it("sets the indeterminate DOM property only while partially selected", () => {
		const { rerender } = render(
			<InHeader>
				<TableSelectAllCell total={3} allSelected={false} someSelected onToggleAll={vi.fn()} />
			</InHeader>,
		);
		const checkbox = screen.getByRole<HTMLInputElement>("checkbox");
		// A DOM PROPERTY, not an attribute — `indeterminate={…}` in JSX does nothing.
		expect(checkbox.indeterminate).toBe(true);
		expect(checkbox.checked).toBe(false);

		rerender(
			<InHeader>
				<TableSelectAllCell total={3} allSelected someSelected onToggleAll={vi.fn()} />
			</InHeader>,
		);
		expect(checkbox.indeterminate).toBe(false);
		expect(checkbox.checked).toBe(true);

		rerender(
			<InHeader>
				<TableSelectAllCell total={3} allSelected={false} someSelected={false} onToggleAll={vi.fn()} />
			</InHeader>,
		);
		expect(checkbox.indeterminate).toBe(false);
	});

	it("fires onToggleAll from the keyboard", async () => {
		const onToggleAll = vi.fn();
		const user = userEvent.setup();
		render(
			<InHeader>
				<TableSelectAllCell total={3} allSelected={false} someSelected={false} onToggleAll={onToggleAll} />
			</InHeader>,
		);
		await user.tab();
		await user.keyboard(" ");
		expect(onToggleAll).toHaveBeenCalledTimes(1);
	});
});

/**
 * The three pieces wired the way a screen wires them (§2.13's worked example).
 * `run_locked` is rendered but NOT in the hook's ids — the row is visible and its
 * checkbox is disabled, so it must never end up selected.
 */
const LOCKED = "run_locked";

function SelectableTable({ max }: { max?: number }) {
	const ids = ["run_a", "run_b", "run_c"];
	const selection = useTableSelection(ids, max === undefined ? undefined : { max });
	return (
		<Table aria-label="Runs">
			<TableHeader>
				<TableRow>
					<TableSelectAllCell
						total={ids.length}
						allSelected={selection.allSelected}
						someSelected={selection.someSelected}
						onToggleAll={() => (selection.allSelected ? selection.clear() : selection.selectAll())}
					/>
				</TableRow>
			</TableHeader>
			<TableBody>
				{ids.map((id) => (
					<TableRow key={id} isSelected={selection.has(id)}>
						<TableSelectCell
							rowLabel={id}
							checked={selection.has(id)}
							onToggle={(extend) => selection.toggle(id, extend)}
						/>
					</TableRow>
				))}
				<TableRow>
					<TableSelectCell rowLabel={LOCKED} checked={selection.has(LOCKED)} disabled onToggle={() => {}} />
				</TableRow>
			</TableBody>
		</Table>
	);
}

describe("selection wired end to end", () => {
	it("marks the row with data-selected — never aria-selected (§2.15 rule 6)", async () => {
		const user = userEvent.setup();
		render(<SelectableTable />);

		await user.click(screen.getByRole("checkbox", { name: "Select run_b" }));

		const row = screen.getByRole("checkbox", { name: "Select run_b" }).closest("tr");
		expect(row).toHaveAttribute("data-selected", "true");
		expect(row).not.toHaveAttribute("aria-selected");
		const untouched = screen.getByRole("checkbox", { name: "Select run_a" }).closest("tr");
		expect(untouched).not.toHaveAttribute("data-selected");
	});

	it("drives the select-all checkbox from unchecked → indeterminate → checked", async () => {
		const user = userEvent.setup();
		render(<SelectableTable />);
		const selectAll = screen.getByRole<HTMLInputElement>("checkbox", { name: "Select all 3 rows" });

		expect(selectAll.indeterminate).toBe(false);

		await user.click(screen.getByRole("checkbox", { name: "Select run_a" }));
		expect(selectAll.indeterminate).toBe(true);
		expect(selectAll.checked).toBe(false);

		await user.click(selectAll);
		expect(selectAll.checked).toBe(true);
		expect(selectAll.indeterminate).toBe(false);
		for (const id of ["run_a", "run_b", "run_c"]) {
			expect(screen.getByRole("checkbox", { name: `Select ${id}` })).toBeChecked();
		}

		await user.click(selectAll);
		expect(selectAll.checked).toBe(false);
		expect(screen.getByRole("checkbox", { name: "Select run_a" })).not.toBeChecked();
	});

	it("extends the selection on a shift-click", async () => {
		const user = userEvent.setup();
		render(<SelectableTable />);

		await user.click(screen.getByRole("checkbox", { name: "Select run_a" }));
		await user.keyboard("{Shift>}");
		await user.click(screen.getByRole("checkbox", { name: "Select run_c" }));
		await user.keyboard("{/Shift}");

		// The row BETWEEN the anchor and the click comes along — that is the whole
		// point of `selectRange` living in the hook.
		expect(screen.getByRole("checkbox", { name: "Select run_b" })).toBeChecked();
	});

	it("never selects a row that is not among the hook's ids", async () => {
		const user = userEvent.setup();
		render(<SelectableTable />);
		const locked = screen.getByRole("checkbox", { name: `Select ${LOCKED}` });
		expect(locked).toBeDisabled();

		await user.click(screen.getByRole("checkbox", { name: "Select all 3 rows" }));

		// Measured in a browser before this guard existed: with the locked row in
		// `ids`, select-all CHECKED a disabled checkbox the user could never uncheck.
		expect(locked).not.toBeChecked();
		expect(screen.getByRole("checkbox", { name: "Select run_c" })).toBeChecked();
	});

	it("skips a non-selectable row when a shift-click spans it", async () => {
		const user = userEvent.setup();
		render(<SelectableTable />);

		await user.click(screen.getByRole("checkbox", { name: "Select run_a" }));
		await user.keyboard("{Shift>}");
		await user.click(screen.getByRole("checkbox", { name: "Select run_c" }));
		await user.keyboard("{/Shift}");

		expect(screen.getByRole("checkbox", { name: `Select ${LOCKED}` })).not.toBeChecked();
	});

	it("refuses a selection past the cap", async () => {
		const user = userEvent.setup();
		render(<SelectableTable max={1} />);

		await user.click(screen.getByRole("checkbox", { name: "Select run_a" }));
		await user.click(screen.getByRole("checkbox", { name: "Select run_b" }));
		expect(screen.getByRole("checkbox", { name: "Select run_b" })).not.toBeChecked();
		expect(screen.getByRole("checkbox", { name: "Select run_a" })).toBeChecked();
	});
});
