import { Button } from "@/components/primitives/Buttons";
import { Table, TableBody } from "@/components/primitives/Table";
import { TableEmpty, TableLoadingOverlay, TableNoResults } from "@/components/primitives/TableBlankState";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

/** Every blank body is a `<tr>`; rendering one outside a table is invalid DOM. */
function InTable({ children }: { children: React.ReactNode }) {
	return (
		<Table aria-label="Runs">
			<TableBody>{children}</TableBody>
		</Table>
	);
}

describe("TableNoResults", () => {
	it("clears the filters from the keyboard, through a real button", async () => {
		const onClearFilters = vi.fn();
		render(
			<InTable>
				<TableNoResults onClearFilters={onClearFilters} />
			</InTable>,
		);
		// A real tab stop (§2.15 rule 3), not a div with an onClick — so the row's
		// only affordance is reachable without a mouse and fires on Enter.
		await userEvent.tab();
		const clear = screen.getByRole("button", { name: "Clear filters" });
		expect(clear).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		expect(onClearFilters).toHaveBeenCalledOnce();
	});

	it("renders NO control when there is nothing to clear", () => {
		render(
			<InTable>
				<TableNoResults />
			</InTable>,
		);
		// §2.6's last bullet: a "Clear filters" button that clears nothing is a lie.
		// The state still reads, it just offers no dead affordance.
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.getByRole("heading", { level: 3, name: "No matching results" })).toBeInTheDocument();
	});

	it("lets E11 swap the copy without touching this file", () => {
		render(
			<InTable>
				<TableNoResults title="No runs match" description="Try a wider time range." />
			</InTable>,
		);
		expect(screen.getByRole("heading", { level: 3, name: "No runs match" })).toBeInTheDocument();
		expect(screen.getByText("Try a wider time range.")).toBeInTheDocument();
	});
});

describe("TableEmpty", () => {
	it("is a DIFFERENT state from no-results: it offers the create action, never clear-filters", async () => {
		const onCreate = vi.fn();
		const onClearFilters = vi.fn();
		const { rerender } = render(
			<InTable>
				<TableEmpty
					icon={<Inbox aria-hidden="true" className="h-6 w-6" />}
					title="No runs yet"
					description="Runs appear here as soon as a workflow is triggered."
					action={<Button onClick={onCreate}>Create workflow</Button>}
				/>
			</InTable>,
		);
		// "Nothing has ever been here" — creating the first record is the only move.
		await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
		expect(onCreate).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();

		// "Your filters excluded everything" — the record may already exist, so the
		// offer is the opposite one and the copy is not shared.
		rerender(
			<InTable>
				<TableNoResults onClearFilters={onClearFilters} />
			</InTable>,
		);
		expect(screen.queryByRole("button", { name: "Create workflow" })).not.toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "No runs yet" })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(onClearFilters).toHaveBeenCalledOnce();
	});

	it("keeps a disabled action honestly disabled", async () => {
		const onCreate = vi.fn();
		render(
			<InTable>
				<TableEmpty
					icon={<Inbox aria-hidden="true" className="h-6 w-6" />}
					title="No runs yet"
					description="You do not have permission to create one."
					action={
						<Button disabled onClick={onCreate}>
							Create workflow
						</Button>
					}
				/>
			</InTable>,
		);
		// The native attribute, not a lookalike: it takes no focus and fires nothing
		// (§2.6). The action is the CALLER's node, so the blank state must not
		// swallow or re-wrap it.
		const create = screen.getByRole("button", { name: "Create workflow" });
		expect(create).toBeDisabled();
		await userEvent.click(create);
		expect(onCreate).not.toHaveBeenCalled();
		await userEvent.tab();
		expect(create).not.toHaveFocus();
	});
});

describe("TableLoadingOverlay", () => {
	it("announces itself once, as a live status region", () => {
		render(
			<InTable>
				<TableLoadingOverlay />
			</InTable>,
		);
		// `Spinner` is an `<output>`, i.e. a role="status" live region — the
		// announcement is its sr-only label, not the visible text.
		expect(within(screen.getByRole("status")).getByText("Loading")).toBeInTheDocument();
		// …and the visible twin is `aria-hidden`, or the row announces the same
		// word twice. Drop that attribute and this name becomes "Loading Loading".
		expect(screen.getByRole("row")).toHaveAccessibleName("Loading");
	});

	it("covers the body, and centres its content against the ROW rather than the cell", () => {
		render(
			<InTable>
				<TableLoadingOverlay />
			</InTable>,
		);
		// jsdom has no layout, so this is §8.3's sanctioned class assertion on the
		// one geometry that was MEASURED: the row covers `<TableBody>` (which is
		// `relative` for this), and the content is positioned against the ROW —
		// because an absolutely positioned `<tr>`'s `<td>` shrink-wraps out of table
		// layout (measured: row 742 x 120.5, cell 73.3 x 20 in the corner).
		const row = screen.getByRole("row");
		expect(row).toHaveClass("absolute", "inset-0");
		const content = row.querySelector("td > div");
		expect(content).toHaveClass("absolute", "inset-0", "items-center", "justify-center");
	});
});

describe("every blank body", () => {
	it("spans the whole table by default and takes an explicit count for table-layout: fixed", () => {
		const { rerender } = render(
			<InTable>
				<TableNoResults />
			</InTable>,
		);
		// The 1000 default is `TableBlankRow`'s: HTML clamps `colspan` there and the
		// surplus columns are zero-width, so nothing hand-counts columns (§2.13).
		// Measured in a browser — under `table-layout: fixed` it is NOT safe, which
		// is why `colSpan` has to reach the row at all.
		expect(screen.getByRole("cell")).toHaveAttribute("colspan", "1000");

		for (const state of [
			<TableNoResults key="n" colSpan={3} />,
			<TableEmpty key="e" colSpan={3} icon={null} title="No runs yet" description="none" />,
			<TableLoadingOverlay key="l" colSpan={3} />,
		]) {
			rerender(<InTable>{state}</InTable>);
			expect(screen.getByRole("cell")).toHaveAttribute("colspan", "3");
		}
	});
});
