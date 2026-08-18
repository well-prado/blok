import { FilterMenu } from "@/components/filters/FilterMenu";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

describe("FilterMenu", () => {
	it("renders its trigger button with an accessible name", () => {
		render(<FilterMenu />);
		expect(screen.getByRole("button", { name: /Filter.../ })).toBeInTheDocument();
	});

	it("sets aria-expanded on the combobox when populated", async () => {
		const user = userEvent.setup();
		render(<FilterMenu />);

		await user.click(screen.getByRole("button", { name: /Filter.../ }));
		const combobox = screen.getByRole("combobox");

		// The combobox is expanded when there are items
		expect(combobox).toHaveAttribute("aria-expanded", "true");
	});

	it("handles keyboard navigation through two levels", async () => {
		const user = userEvent.setup();
		render(<FilterMenu />);

		await user.click(screen.getByRole("button", { name: /Filter.../ }));

		const combobox = screen.getByRole("combobox");

		// Move down to the first item
		await user.keyboard("{ArrowDown}");

		// Assert that activedescendant is set
		expect(combobox).toHaveAttribute("aria-activedescendant");

		// Select the first level (fields)
		await user.keyboard("{Enter}");

		// Verify transition to second level (values)
		await waitFor(() => {
			expect(combobox).toHaveAttribute("placeholder", "Search values...");
		});

		// Select the value, which closes the menu
		await user.keyboard("{Enter}");

		await waitFor(() => {
			expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		});
	});
});
