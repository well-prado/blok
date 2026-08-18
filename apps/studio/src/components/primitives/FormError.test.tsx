import { FormError } from "@/components/primitives/FormError";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("FormError", () => {
	it("becomes the invalid control's accessible description when wired by id", () => {
		render(
			<>
				<input aria-label="Slug" aria-invalid="true" aria-describedby="slug-error" />
				<FormError id="slug-error">Slug is taken</FormError>
			</>,
		);
		expect(screen.getByRole("textbox", { name: "Slug" })).toHaveAccessibleDescription("Slug is taken");
	});

	it("renders nothing when there is no message", () => {
		const { container } = render(<FormError>{undefined}</FormError>);
		expect(container).toBeEmptyDOMElement();
	});

	it("hides its decorative glyph from assistive tech", () => {
		const { container } = render(<FormError>Slug is taken</FormError>);
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	});
});
