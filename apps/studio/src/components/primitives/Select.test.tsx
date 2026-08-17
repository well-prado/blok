import { Select } from "@/components/primitives/Select";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

function Options() {
	return (
		<>
			<option value="dev">Development</option>
			<option value="prod">Production</option>
		</>
	);
}

describe("Select", () => {
	it("is reachable by its associated label", () => {
		render(
			<>
				<label htmlFor="env">Environment</label>
				<Select id="env">
					<Options />
				</Select>
			</>,
		);
		expect(screen.getByLabelText("Environment")).toBeInTheDocument();
	});

	it("changes value from the option list", async () => {
		render(
			<Select aria-label="Environment">
				<Options />
			</Select>,
		);
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Environment" }), "prod");
		expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue("prod");
	});

	it("hides the decorative chevron from assistive tech", () => {
		const { container } = render(
			<Select aria-label="Environment">
				<Options />
			</Select>,
		);
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	});
});
