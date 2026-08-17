import { Accordion, AccordionItem } from "@/components/primitives/Accordion";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

describe("Accordion", () => {
	// jsdom implements `<details>` activation on click but user-event does not
	// synthesize the activation click for Enter on a `<summary>` (it only does so
	// for `<button>`/`<a>`), so keyboard REACHABILITY is asserted here and the
	// toggle is driven by click. Real browsers activate on Enter and Space.
	it("starts collapsed, is keyboard reachable, and toggles", async () => {
		const user = userEvent.setup();
		render(
			<Accordion>
				<AccordionItem title="Inputs">payload</AccordionItem>
			</Accordion>,
		);
		const summary = screen.getByText("Inputs").closest("summary");
		const details = summary?.closest("details");

		expect(details).not.toHaveAttribute("open");
		summary?.focus();
		expect(summary).toHaveFocus();

		if (summary) await user.click(summary);
		expect(details).toHaveAttribute("open");
	});

	it("groups items under one native name when exclusive", () => {
		render(
			<Accordion exclusive>
				<AccordionItem title="Inputs">a</AccordionItem>
				<AccordionItem title="Outputs">b</AccordionItem>
			</Accordion>,
		);
		const names = screen.getAllByText(/Inputs|Outputs/).map((el) => el.closest("details")?.getAttribute("name"));

		expect(names[0]).toBeTruthy();
		expect(names[0]).toBe(names[1]);
	});

	it("does not toggle a disabled item", async () => {
		const user = userEvent.setup();
		render(
			<Accordion>
				<AccordionItem title="Locked" disabled>
					payload
				</AccordionItem>
			</Accordion>,
		);
		const summary = screen.getByText("Locked").closest("summary");
		const details = summary?.closest("details");

		expect(summary).toHaveAttribute("aria-disabled", "true");
		if (summary) await user.click(summary);
		expect(details).not.toHaveAttribute("open");
	});
});
