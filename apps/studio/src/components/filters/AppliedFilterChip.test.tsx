import type { FilterFieldDef } from "@/lib/filterTypes";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppliedFilterChip } from "./AppliedFilterChip";

describe("AppliedFilterChip", () => {
	const mockField: FilterFieldDef = { key: "status", label: "Status" };

	it("renders field label and value", () => {
		render(<AppliedFilterChip field={mockField} value="running" onRemove={() => {}} />);
		expect(screen.getByText("Status:")).toBeInTheDocument();
		expect(screen.getByText("running")).toBeInTheDocument();
	});

	it("calls onRemove when remove button is clicked", async () => {
		const user = userEvent.setup();
		const onRemove = vi.fn();
		render(<AppliedFilterChip field={mockField} value="failed" onRemove={onRemove} />);

		const removeBtn = screen.getByRole("button", { name: "Remove Status filter" });
		await user.click(removeBtn);

		expect(onRemove).toHaveBeenCalledOnce();
	});

	it("calls onClick when label is clicked", async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		render(<AppliedFilterChip field={mockField} value="failed" onRemove={() => {}} onClick={onClick} />);

		const editBtn = screen.getByRole("button", { name: "Edit Status filter" });
		await user.click(editBtn);

		expect(onClick).toHaveBeenCalledOnce();
	});
});
