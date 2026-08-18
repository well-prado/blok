import { ExportMenu, SimpleDropdownMenu } from "@/components/primitives/DropdownMenu";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("DropdownMenu", () => {
	it("exposes menu semantics the hand-rolled menu never had", async () => {
		const user = userEvent.setup();
		render(
			<SimpleDropdownMenu
				trigger={<button type="button">Actions</button>}
				items={[
					{ label: "Replay", onSelect: () => {} },
					{ label: "Delete", onSelect: () => {}, tone: "error", disabled: true },
				]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Actions" }));

		expect(await screen.findByRole("menu")).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
	});

	it("selects an item with the keyboard alone", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<SimpleDropdownMenu trigger={<button type="button">Actions</button>} items={[{ label: "Replay", onSelect }]} />,
		);

		screen.getByRole("button", { name: "Actions" }).focus();
		await user.keyboard("{Enter}");
		await screen.findByRole("menu");
		await user.keyboard("{ArrowDown}{Enter}");

		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		const user = userEvent.setup();
		render(<ExportMenu onExportJson={() => {}} onExportCsv={() => {}} />);
		const trigger = screen.getByRole("button", { name: /Export/ });

		await user.click(trigger);
		expect(await screen.findByRole("menuitem", { name: "Export as CSV" })).toBeInTheDocument();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});
});
