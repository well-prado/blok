import { InlineCode } from "@/components/primitives/InlineCode";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("InlineCode", () => {
	it("renders its children inside a <code> element", () => {
		render(<InlineCode>run_01H8</InlineCode>);
		// `code` carries no ARIA role, so the tag is the semantic signal.
		expect(screen.getByText("run_01H8").tagName).toBe("CODE");
	});

	it("applies the size variant", () => {
		render(<InlineCode variant="base">run_01H8</InlineCode>);
		expect(screen.getByText("run_01H8")).toHaveClass("text-base");
	});

	it("forwards native attributes and lets className win", () => {
		render(
			<InlineCode className="font-sans" data-testid="ref">
				run_01H8
			</InlineCode>,
		);
		// `cn()` takes className last, so a caller can override the mono default.
		const el = screen.getByTestId("ref");
		expect(el).toHaveClass("font-sans");
		expect(el).not.toHaveClass("font-mono");
	});
});
