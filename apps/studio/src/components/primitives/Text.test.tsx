import { Text } from "@/components/primitives/Text";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Text", () => {
	it("renders its children in a span", () => {
		render(<Text>run_01H8Z3K9</Text>);
		expect(screen.getByText("run_01H8Z3K9").tagName).toBe("SPAN");
	});

	it("applies the ink", () => {
		render(<Text ink="dimmed">Dim</Text>);
		// Nothing semantic separates ink, so one discriminating class (§8.3.2).
		expect(screen.getByText("Dim")).toHaveClass("text-ink-dimmed");
	});

	it("treats mono and numeric as independent flags", () => {
		const { rerender } = render(
			<Text mono numeric>
				1.24s
			</Text>,
		);
		expect(screen.getByText("1.24s")).toHaveClass("font-mono", "tabular-nums");
		rerender(<Text numeric>1.24s</Text>);
		expect(screen.getByText("1.24s")).toHaveClass("tabular-nums");
		expect(screen.getByText("1.24s")).not.toHaveClass("font-mono");
	});
});
