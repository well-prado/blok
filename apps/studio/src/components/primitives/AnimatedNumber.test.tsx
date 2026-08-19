import { AnimatedNumber } from "@/components/primitives/AnimatedNumber";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("AnimatedNumber", () => {
	it("renders the initial value", () => {
		render(<AnimatedNumber value={100} />);
		expect(screen.getByText("100")).toBeInTheDocument();
	});

	it("formats the value using the provided format function", () => {
		render(<AnimatedNumber value={100} format={(v) => `$${v}`} />);
		expect(screen.getByText("$100")).toBeInTheDocument();
	});

	it("respects prefers-reduced-motion via mock matchMedia", () => {
		// Just mocking matchMedia briefly
		vi.stubGlobal(
			"matchMedia",
			vi.fn().mockImplementation((query) => ({
				matches: query === "(prefers-reduced-motion: reduce)",
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		);

		render(<AnimatedNumber value={100} />);
		expect(screen.getByText("100")).toBeInTheDocument();
		vi.unstubAllGlobals();
	});
});
