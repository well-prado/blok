import type { DropdownMenuEntry } from "@/components/primitives/DropdownMenu";
import { Table, TableBody, TableCell, TableRow } from "@/components/primitives/Table";
import type { TableDensity } from "@/components/primitives/Table";
import { TableRowActions } from "@/components/primitives/TableRowActions";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

function Row({
	items,
	density,
	rowLabel = "run_01H8Z3K9",
}: {
	items: DropdownMenuEntry[];
	density?: TableDensity;
	rowLabel?: string;
}) {
	return (
		<Table aria-label="Runs" density={density}>
			<TableBody>
				<TableRow>
					<TableCell>
						{/* A real preceding tab stop: the row's primary link (§2.15 rule 3). */}
						<a href="/runs/1">{rowLabel}</a>
					</TableCell>
					<TableRowActions items={items} rowLabel={rowLabel} />
				</TableRow>
			</TableBody>
		</Table>
	);
}

describe("TableRowActions", () => {
	it("names the trigger for its ROW and opens a real menu", async () => {
		const user = userEvent.setup();
		render(
			<Row
				items={[
					{ label: "Replay", onSelect: () => {} },
					{ label: "Cancel", onSelect: () => {}, disabled: true },
				]}
			/>,
		);

		// §2.15 rule 10: the row is in the name, or a screen-reader user hears
		// "Actions, button" once per row with nothing to tell them apart.
		const trigger = screen.getByRole("button", { name: "Actions for run_01H8Z3K9" });
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();

		await user.click(trigger);
		expect(await screen.findByRole("menu")).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Replay" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Cancel" })).toHaveAttribute("aria-disabled", "true");
	});

	/**
	 * THE test. The reference reveals row actions with `hidden
	 * group-hover/table-row:block`, so this sequence is impossible there: a
	 * `display:none` button is not in the tab order at all. Nothing here uses a
	 * mouse.
	 */
	it("is reachable and operable with the keyboard alone, with no hover", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(<Row items={[{ label: "Replay", onSelect }]} />);
		const trigger = screen.getByRole("button", { name: "Actions for run_01H8Z3K9" });

		await user.tab(); // the row's primary link
		expect(screen.getByRole("link", { name: "run_01H8Z3K9" })).toHaveFocus();
		await user.tab(); // …and the action trigger is the very next tab stop
		expect(trigger).toHaveFocus();

		await user.keyboard("{Enter}");
		await screen.findByRole("menu");
		await user.keyboard("{ArrowDown}{Enter}");
		expect(onSelect).toHaveBeenCalledOnce();
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		const user = userEvent.setup();
		render(<Row items={[{ label: "Replay", onSelect: () => {} }]} />);
		const trigger = screen.getByRole("button", { name: "Actions for run_01H8Z3K9" });

		trigger.focus();
		await user.keyboard(" ");
		expect(await screen.findByRole("menu")).toBeInTheDocument();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("reveals with opacity and NEVER display:none, on all four triggers plus touch", () => {
		render(<Row items={[{ label: "Replay", onSelect: () => {} }]} />);
		const trigger = screen.getByRole("button", { name: "Actions for run_01H8Z3K9" });

		// Nothing semantic distinguishes "hidden until hovered" from "removed from
		// the tab order" — the class string IS the difference, so §8.3 point 2's
		// class-assertion fallback applies here.
		expect(trigger).toHaveClass(
			"opacity-0",
			"group-hover/row:opacity-100", // mouse anywhere on the row
			"group-focus-within/row:opacity-100", // keyboard focus anywhere in the row
			"focus-visible:opacity-100", // the trigger itself
			"pointer-coarse:opacity-100", // touch: no hover, no Tab
		);
		// The reference's actual class. `hidden` is what breaks the tab order.
		expect(trigger).not.toHaveClass("hidden");
		// And `transition-colors` would make `.focus-ring` fade in from the
		// button's text color (§2.12 rule 10).
		expect(trigger.className).not.toMatch(/\btransition-colors\b/);
	});

	it("stays visible while its own menu is open, after the pointer has left the row", async () => {
		const user = userEvent.setup();
		render(<Row items={[{ label: "Replay", onSelect: () => {} }]} />);
		const trigger = screen.getByRole("button", { name: "Actions for run_01H8Z3K9" });

		// The menu is portaled to <body>, i.e. outside the `<tr>`, so moving the
		// mouse into it drops `group-hover/row:` and the trigger would blink out
		// from under its own open menu. Radix's `data-state` is the fix.
		await user.click(trigger);
		expect(trigger).toHaveAttribute("data-state", "open");
		expect(trigger).toHaveClass("data-[state=open]:opacity-100");
	});

	it("sizes the trigger to the table's density and pins its cell to the right edge", () => {
		const { rerender } = render(<Row density="compact" items={[{ label: "Replay", onSelect: () => {} }]} />);
		// 24px in a 28px compact row — the fit invariant (§2.11), and exactly WCAG
		// 2.2 AA 2.5.8's minimum target. Read from context, never prop-drilled.
		expect(screen.getByRole("button", { name: /^Actions for/ })).toHaveClass("h-6", "w-6");

		rerender(<Row density="comfortable" items={[{ label: "Replay", onSelect: () => {} }]} />);
		expect(screen.getByRole("button", { name: /^Actions for/ })).toHaveClass("h-7", "w-7");

		// The action column survives horizontal scrolling; `bg-inherit` is what
		// makes it track the row's hover/selected paint (§2.12 rule 3).
		const cells = screen.getAllByRole("cell");
		expect(cells[cells.length - 1]).toHaveClass("sticky", "bg-inherit");
	});

	it("renders no affordance at all when the row has no actions", () => {
		render(<Row items={[]} />);
		expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();
		// …but the cell stays, so the column keeps its width and rows stay aligned.
		expect(screen.getAllByRole("cell")).toHaveLength(2);
	});
});
