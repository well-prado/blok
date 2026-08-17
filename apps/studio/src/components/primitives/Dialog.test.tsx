import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/primitives/Dialog";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

function Fixture() {
	return (
		<Dialog>
			<DialogTrigger>Open run</DialogTrigger>
			<DialogContent>
				<DialogTitle>Run details</DialogTitle>
				<button type="button">Inside</button>
			</DialogContent>
		</Dialog>
	);
}

describe("Dialog", () => {
	it("opens as a modal dialog named by its title and moves focus inside", async () => {
		const user = userEvent.setup();
		render(<Fixture />);

		await user.click(screen.getByRole("button", { name: "Open run" }));

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveAccessibleName("Run details");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	// Radix locks scroll through `react-remove-scroll`, which marks the body and
	// injects a stylesheet rather than setting `body.style.overflow` — probed, not
	// assumed. (CONVENTIONS §9 also claims Radix sets `aria-modal`; it does not —
	// it hides the rest of the tree with `aria-hidden` instead.)
	it("locks body scroll while open and releases it on close", async () => {
		const user = userEvent.setup();
		render(<Fixture />);

		await user.click(screen.getByRole("button", { name: "Open run" }));
		await screen.findByRole("dialog");
		expect(document.body).toHaveAttribute("data-scroll-locked");

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(document.body).not.toHaveAttribute("data-scroll-locked");
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		const user = userEvent.setup();
		render(<Fixture />);
		const trigger = screen.getByRole("button", { name: "Open run" });

		await user.click(trigger);
		await screen.findByRole("dialog");
		await user.keyboard("{Escape}");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});
});
