import { TextArea } from "@/components/primitives/TextArea";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

describe("TextArea", () => {
	it("is reachable by its associated label and accepts multi-line text", async () => {
		render(
			<>
				<label htmlFor="notes">Notes</label>
				<TextArea id="notes" />
			</>,
		);
		await userEvent.type(screen.getByLabelText("Notes"), "one{Enter}two");
		expect(screen.getByLabelText("Notes")).toHaveValue("one\ntwo");
	});

	it("carries aria-invalid and its description when the field is in error", () => {
		render(
			<>
				<TextArea aria-label="Notes" aria-invalid="true" aria-describedby="notes-error" />
				<p id="notes-error">Too long</p>
			</>,
		);
		expect(screen.getByRole("textbox", { name: "Notes" })).toHaveAccessibleDescription("Too long");
	});

	it("accepts no input when disabled", async () => {
		render(<TextArea aria-label="Notes" disabled />);
		await userEvent.type(screen.getByRole("textbox", { name: "Notes" }), "hello");
		expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("");
	});
});
