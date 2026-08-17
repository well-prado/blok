import { Fieldset } from "@/components/primitives/Fieldset";
import { RadioButton } from "@/components/primitives/RadioButton";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

function Group({ disabled }: { disabled?: boolean }) {
	return (
		<Fieldset legend="Environment" disabled={disabled}>
			<RadioButton name="env" value="dev" label="Development" defaultChecked />
			<RadioButton name="env" value="prod" label="Production" description="Runs against live data" />
		</Fieldset>
	);
}

describe("RadioButton", () => {
	it("is named by its label and grouped by the surrounding fieldset legend", () => {
		render(<Group />);
		expect(screen.getByRole("group", { name: "Environment" })).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /Production/ })).toBeInTheDocument();
	});

	it("deselects its siblings when chosen", async () => {
		render(<Group />);
		await userEvent.click(screen.getByText("Production"));
		expect(screen.getByRole("radio", { name: /Production/ })).toBeChecked();
		expect(screen.getByRole("radio", { name: "Development" })).not.toBeChecked();
	});

	it("cannot be chosen when the fieldset disables it", async () => {
		render(<Group disabled />);
		await userEvent.click(screen.getByText("Production"));
		expect(screen.getByRole("radio", { name: /Production/ })).not.toBeChecked();
	});
});
