import { Resizable } from "@/components/primitives/Resizable";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("Resizable", () => {
	it("exposes the split as a separator with a value range", () => {
		render(<Resizable first={<p>left</p>} second={<p>right</p>} defaultSize={40} min={20} max={80} />);
		const handle = screen.getByRole("separator", { name: "Resize panes" });

		expect(handle).toHaveAttribute("aria-orientation", "vertical");
		expect(handle).toHaveAttribute("aria-valuenow", "40");
		expect(handle).toHaveAttribute("aria-valuemin", "20");
		expect(handle).toHaveAttribute("aria-valuemax", "80");
	});

	it("resizes with arrow keys and clamps at the bounds", async () => {
		const user = userEvent.setup();
		render(<Resizable first={<p>left</p>} second={<p>right</p>} defaultSize={50} min={20} max={80} />);
		const handle = screen.getByRole("separator", { name: "Resize panes" });

		handle.focus();
		await user.keyboard("{ArrowRight}");
		expect(handle).toHaveAttribute("aria-valuenow", "52");

		await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
		expect(handle).toHaveAttribute("aria-valuenow", "42");

		await user.keyboard("{End}");
		expect(handle).toHaveAttribute("aria-valuenow", "80");
		await user.keyboard("{ArrowRight}");
		expect(handle).toHaveAttribute("aria-valuenow", "80");
	});

	it("reports changes to a controlled owner without moving itself", async () => {
		const user = userEvent.setup();
		const onSizeChange = vi.fn();
		render(<Resizable first={<p>left</p>} second={<p>right</p>} size={30} onSizeChange={onSizeChange} />);
		const handle = screen.getByRole("separator", { name: "Resize panes" });

		handle.focus();
		await user.keyboard("{Home}");

		expect(onSizeChange).toHaveBeenCalledWith(10);
		expect(handle).toHaveAttribute("aria-valuenow", "30");
	});
});
