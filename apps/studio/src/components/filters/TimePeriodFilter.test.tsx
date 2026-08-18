// @ts-nocheck
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimePeriodFilter } from "./TimePeriodFilter";

describe("TimePeriodFilter", () => {
	it("renders with default label", () => {
		render(<TimePeriodFilter value={null} onChange={vi.fn()} />);
		expect(screen.getByRole("button", { name: /Time Period/i })).toBeInTheDocument();
	});

	it("shows formatted value when selected", () => {
		render(<TimePeriodFilter value={{ type: "relative", value: "1h" }} onChange={vi.fn()} />);
		expect(screen.getByRole("button", { name: /Last 1h/i })).toBeInTheDocument();
	});

	it("opens popover and allows preset selection", () => {
		const onChange = vi.fn();
		render(<TimePeriodFilter value={null} onChange={onChange} />);

		// Open popover
		fireEvent.click(screen.getByRole("button", { name: /Time Period/i }));

		// Click preset
		const presetBtn = screen.getByRole("button", { name: "30m" });
		fireEvent.click(presetBtn);

		expect(onChange).toHaveBeenCalledWith({ type: "relative", value: "30m" });
	});

	it("handles custom relative input", () => {
		const onChange = vi.fn();
		render(<TimePeriodFilter value={null} onChange={onChange} />);

		fireEvent.click(screen.getByRole("button", { name: /Time Period/i }));

		const input = screen.getByPlaceholderText("e.g. 45m, 2h");
		fireEvent.change(input, { target: { value: "45m" } });

		const applyBtn = screen.getByRole("button", { name: "Apply" });
		fireEvent.click(applyBtn);

		expect(onChange).toHaveBeenCalledWith({ type: "relative", value: "45m" });
	});

	it("handles custom absolute range", () => {
		const onChange = vi.fn();
		render(<TimePeriodFilter value={null} onChange={onChange} />);

		fireEvent.click(screen.getByRole("button", { name: /Time Period/i }));

		const inputs = screen.getAllByDisplayValue("");
		// The two absolute inputs are datetime-local, they don't have placeholder text.
		// There are three inputs total: one for custom relative, two for absolute.
		// Since we have empty values, let's grab by type instead or order.
		const datetimeInputs =
			screen
				.getAllByRole("textbox")
				.filter(
					(el) => (el as HTMLInputElement).type === "text" || (el as HTMLInputElement).type === "datetime-local",
				) || [];

		// The datetime-local inputs are not exposed as textboxes usually.
		// We can get them by Label? Wait, there are labels.
		const fromInput = screen.getByLabelText("From") as HTMLInputElement;
		const toInput = screen.getByLabelText("To") as HTMLInputElement;

		// "2026-08-18T12:00" => timestamp
		const d1 = new Date("2026-08-18T12:00").getTime();
		const d2 = new Date("2026-08-18T13:00").getTime();

		fireEvent.change(fromInput, { target: { value: "2026-08-18T12:00" } });
		fireEvent.change(toInput, { target: { value: "2026-08-18T13:00" } });

		const applyRangeBtn = screen.getByRole("button", { name: "Apply Range" });
		fireEvent.click(applyRangeBtn);

		expect(onChange).toHaveBeenCalledWith({ type: "absolute", from: d1, to: d2 });
	});

	it("can clear filter", () => {
		const onChange = vi.fn();
		render(<TimePeriodFilter value={{ type: "relative", value: "5m" }} onChange={onChange} />);

		fireEvent.click(screen.getByRole("button", { name: /Last 5m/i }));

		const clearBtn = screen.getByRole("button", { name: "Clear Filter" });
		fireEvent.click(clearBtn);

		expect(onChange).toHaveBeenCalledWith(null);
	});
});
