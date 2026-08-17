import { Switch } from "@/components/primitives/Switch";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("Switch", () => {
	it("is named by its label without the caller supplying an id", () => {
		render(<Switch label="Enable tracing" />);
		expect(screen.getByRole("switch", { name: "Enable tracing" })).toBeInTheDocument();
	});

	it("toggles from the keyboard and reports its state", async () => {
		const onCheckedChange = vi.fn();
		render(<Switch label="Enable tracing" onCheckedChange={onCheckedChange} />);
		const toggle = screen.getByRole("switch");
		expect(toggle).toHaveAttribute("aria-checked", "false");
		await userEvent.tab();
		expect(toggle).toHaveFocus();
		await userEvent.keyboard(" ");
		expect(onCheckedChange).toHaveBeenCalledWith(true);
		expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	it("fires nothing when disabled", async () => {
		const onCheckedChange = vi.fn();
		render(<Switch label="Enable tracing" disabled onCheckedChange={onCheckedChange} />);
		await userEvent.click(screen.getByRole("switch"));
		expect(onCheckedChange).not.toHaveBeenCalled();
	});
});
