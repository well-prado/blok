import { InputGroup } from "@/components/primitives/InputGroup";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

describe("InputGroup", () => {
	it("keeps the label, control and hint of one field in the same accessible unit", async () => {
		render(
			<InputGroup>
				<label htmlFor="slug">Slug</label>
				<input id="slug" aria-describedby="slug-hint" />
				<p id="slug-hint">Lowercase only.</p>
			</InputGroup>,
		);
		await userEvent.click(screen.getByText("Slug"));
		expect(screen.getByLabelText("Slug")).toHaveFocus();
		expect(screen.getByLabelText("Slug")).toHaveAccessibleDescription("Lowercase only.");
	});
});
