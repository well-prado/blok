import { Fieldset } from "@/components/primitives/Fieldset";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Fieldset", () => {
	it("names the group with its legend", () => {
		render(
			<Fieldset legend="Retry policy">
				<input aria-label="Attempts" />
			</Fieldset>,
		);
		expect(screen.getByRole("group", { name: "Retry policy" })).toBeInTheDocument();
	});

	it("disables every control inside it", () => {
		render(
			<Fieldset legend="Retry policy" disabled>
				<input aria-label="Attempts" />
			</Fieldset>,
		);
		expect(screen.getByRole("textbox", { name: "Attempts" })).toBeDisabled();
	});
});
