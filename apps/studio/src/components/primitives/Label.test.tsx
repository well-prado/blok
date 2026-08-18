import { Label } from "@/components/primitives/Label";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

describe("Label", () => {
	it("names and focuses the control it points at", async () => {
		render(
			<>
				<Label htmlFor="name">Workflow name</Label>
				<input id="name" />
			</>,
		);
		await userEvent.click(screen.getByText("Workflow name"));
		expect(screen.getByLabelText("Workflow name")).toHaveFocus();
	});

	it("marks optional fields as optional and says nothing when required", () => {
		const { rerender } = render(<Label required={false}>Description</Label>);
		expect(screen.getByText("(optional)")).toBeInTheDocument();
		rerender(<Label>Description</Label>);
		expect(screen.queryByText("(optional)")).not.toBeInTheDocument();
	});
});
