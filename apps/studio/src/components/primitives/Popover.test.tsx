import { SimplePopover } from "@/components/primitives/Popover";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

function Fixture() {
	return (
		<SimplePopover trigger={<button type="button">Columns</button>} heading="Visible columns">
			<button type="button">Duration</button>
		</SimplePopover>
	);
}

describe("Popover", () => {
	it("renders its content only once opened", async () => {
		const user = userEvent.setup();
		render(<Fixture />);

		expect(screen.queryByText("Visible columns")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Columns" }));
		expect(await screen.findByText("Visible columns")).toBeInTheDocument();
	});

	it("flips aria-expanded on the trigger", async () => {
		const user = userEvent.setup();
		render(<Fixture />);
		const trigger = screen.getByRole("button", { name: "Columns" });

		expect(trigger).toHaveAttribute("aria-expanded", "false");
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		const user = userEvent.setup();
		render(<Fixture />);
		const trigger = screen.getByRole("button", { name: "Columns" });

		await user.click(trigger);
		await screen.findByText("Visible columns");
		await user.keyboard("{Escape}");

		expect(screen.queryByText("Visible columns")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});
});
