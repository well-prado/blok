import { Hint } from "@/components/primitives/Hint";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Hint", () => {
	it("becomes the control's accessible description when wired by id", () => {
		render(
			<>
				<input aria-label="Slug" aria-describedby="slug-hint" />
				<Hint id="slug-hint">Lowercase, no spaces.</Hint>
			</>,
		);
		expect(screen.getByRole("textbox", { name: "Slug" })).toHaveAccessibleDescription("Lowercase, no spaces.");
	});
});
