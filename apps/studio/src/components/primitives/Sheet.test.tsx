import { Sheet, SheetContent, SheetTitle, SimpleSheet } from "@/components/primitives/Sheet";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

describe("Sheet", () => {
	it("opens from the trigger and traps focus in a titled modal", async () => {
		const user = userEvent.setup();
		render(
			<SimpleSheet trigger={<button type="button">Filters</button>} title="Filters" description="Narrow the run list">
				<button type="button">Apply</button>
			</SimpleSheet>,
		);

		await user.click(screen.getByRole("button", { name: "Filters" }));

		const sheet = await screen.findByRole("dialog");
		expect(sheet).toHaveAccessibleName("Filters");
		expect(sheet).toHaveAccessibleDescription("Narrow the run list");
		expect(sheet.contains(document.activeElement)).toBe(true);
	});

	it("anchors to the requested side", () => {
		render(
			<Sheet open>
				<SheetContent side="left">
					<SheetTitle>Panel</SheetTitle>
				</SheetContent>
			</Sheet>,
		);
		// No semantic signal distinguishes the sides, so exactly one discriminating class.
		expect(screen.getByRole("dialog")).toHaveClass("left-0");
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		const user = userEvent.setup();
		render(
			<SimpleSheet trigger={<button type="button">Filters</button>} title="Filters">
				body
			</SimpleSheet>,
		);
		const trigger = screen.getByRole("button", { name: "Filters" });

		await user.click(trigger);
		await screen.findByRole("dialog");
		await user.keyboard("{Escape}");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});
});
