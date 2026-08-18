import { Paragraph } from "@/components/primitives/Paragraph";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Paragraph", () => {
	it("renders its children as a paragraph", () => {
		render(<Paragraph>Waiting on upstream node</Paragraph>);
		expect(screen.getByText("Waiting on upstream node").tagName).toBe("P");
	});

	it("applies the size", () => {
		render(<Paragraph size="sm">Tiny</Paragraph>);
		// Nothing semantic separates the type scale, so one discriminating class.
		expect(screen.getByText("Tiny")).toHaveClass("text-xs");
	});

	it("ships no margin until spacing is opted into", () => {
		const { rerender } = render(<Paragraph size="lg">Body</Paragraph>);
		expect(screen.getByText("Body")).not.toHaveClass("mb-3");
		rerender(
			<Paragraph size="lg" spacing>
				Body
			</Paragraph>,
		);
		expect(screen.getByText("Body")).toHaveClass("mb-3");
	});
});
