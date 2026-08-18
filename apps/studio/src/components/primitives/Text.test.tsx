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

	// §2.11 legislates cell text PER DENSITY and, three bullets later, mandates
	// `<Text mono numeric>` for id/duration/count cells. A `size` default put
	// `text-sm` on the span, which beat the `<td>`'s `text-xs`: a compact row
	// rendered its id, duration and count at 14px beside a plain cell at 12px.
	// Only `compact` was wrong, which is why no demo caught it — the other two
	// densities are `text-sm` anyway. Omitting `size` must emit NO size class.
	it("inherits the surrounding size when `size` is omitted", () => {
		render(
			<Text mono numeric>
				run_d1f7dca7
			</Text>,
		);
		const el = screen.getByText("run_d1f7dca7");
		expect(el.className).not.toMatch(/\btext-(xs|sm|base)\b/);
		expect(el).toHaveClass("font-mono", "tabular-nums");
	});

	it("still emits a size class when one is asked for", () => {
		render(<Text size="sm">explicit</Text>);
		expect(screen.getByText("explicit")).toHaveClass("text-xs");
	});
});
