import { Checkbox } from "@/components/primitives/Checkbox";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("Checkbox", () => {
	it("is named by its label without the caller supplying an id", () => {
		render(<Checkbox label="Retry on failure" />);
		expect(screen.getByRole("checkbox", { name: "Retry on failure" })).toBeInTheDocument();
	});

	it("toggles from the keyboard", async () => {
		render(<Checkbox label="Retry on failure" />);
		await userEvent.tab();
		expect(screen.getByRole("checkbox")).toHaveFocus();
		await userEvent.keyboard(" ");
		expect(screen.getByRole("checkbox")).toBeChecked();
	});

	it("fires nothing when disabled", async () => {
		const onChange = vi.fn();
		render(<Checkbox label="Retry on failure" disabled onChange={onChange} />);
		await userEvent.click(screen.getByText("Retry on failure"));
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("checkbox")).not.toBeChecked();
	});
});
