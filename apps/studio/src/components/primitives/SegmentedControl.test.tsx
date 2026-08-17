import { SegmentedControl } from "@/components/primitives/SegmentedControl";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const options = [
	{ label: "Runs", value: "runs" },
	{ label: "Logs", value: "logs" },
];

describe("SegmentedControl", () => {
	it("exposes a named group of radios, one per option", () => {
		render(<SegmentedControl name="view" label="View" options={options} defaultValue="runs" />);
		expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
		expect(screen.getAllByRole("radio")).toHaveLength(2);
		expect(screen.getByRole("radio", { name: "Runs" })).toBeChecked();
	});

	it("reports the chosen value and deselects the previous segment", async () => {
		const onChange = vi.fn();
		render(<SegmentedControl name="view" label="View" options={options} defaultValue="runs" onChange={onChange} />);
		await userEvent.click(screen.getByRole("radio", { name: "Logs" }));
		expect(onChange).toHaveBeenCalledWith("logs");
		expect(screen.getByRole("radio", { name: "Runs" })).not.toBeChecked();
	});

	it("chooses nothing when disabled", async () => {
		const onChange = vi.fn();
		render(
			<SegmentedControl name="view" label="View" options={options} defaultValue="runs" onChange={onChange} disabled />,
		);
		await userEvent.click(screen.getByRole("radio", { name: "Logs" }));
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("radio", { name: "Runs" })).toBeChecked();
	});
});
