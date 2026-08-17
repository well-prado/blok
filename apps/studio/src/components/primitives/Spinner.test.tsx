import { Spinner } from "@/components/primitives/Spinner";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// The exemplar test: three assertions, no Tailwind snapshots, semantic signals
// preferred over class assertions. See `_design/CONVENTIONS.md` §8.3.
describe("Spinner", () => {
	it("announces itself as a status region with a screen-reader label", () => {
		render(<Spinner label="Fetching runs" />);
		// `status` is a live region, so the text is what gets announced — it is not
		// an accessible *name*, which is why this asserts content, not name.
		expect(screen.getByRole("status")).toHaveTextContent("Fetching runs");
	});

	it("hides the decorative glyph from assistive tech", () => {
		const { container } = render(<Spinner />);
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	});

	it("applies the size variant", () => {
		const { container } = render(<Spinner size="lg" />);
		// No semantic signal distinguishes sizes, so exactly one discriminating class.
		expect(container.querySelector("svg")).toHaveClass("h-6");
	});
});
