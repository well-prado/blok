import * as useReducedMotionHook from "@/hooks/use-reduced-motion";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedPanel } from "./AnimatedPanel";

vi.mock("@/hooks/use-reduced-motion", () => ({
	useReducedMotion: vi.fn(),
}));

describe("AnimatedPanel", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(useReducedMotionHook.useReducedMotion).mockReturnValue(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("renders children and defaults to visible", () => {
		render(<AnimatedPanel>Panel Content</AnimatedPanel>);
		expect(screen.getByText("Panel Content")).toBeInTheDocument();
	});

	it("applies scale and translate classes initially", () => {
		render(<AnimatedPanel>Panel Content</AnimatedPanel>);
		const element = screen.getByTestId("animated-panel");
		expect(element.className).toContain("opacity-0");
		expect(element.className).toContain("scale-95");
		expect(element.className).toContain("translate-y-2");
	});

	it("transitions to fully visible state", () => {
		render(<AnimatedPanel>Panel Content</AnimatedPanel>);
		const element = screen.getByTestId("animated-panel");

		act(() => {
			vi.advanceTimersByTime(20);
		});

		expect(element.className).toContain("opacity-100");
		expect(element.className).toContain("scale-100");
		expect(element.className).toContain("translate-y-0");
	});

	it("skips animation if prefers-reduced-motion is true", () => {
		vi.mocked(useReducedMotionHook.useReducedMotion).mockReturnValue(true);
		render(<AnimatedPanel>Panel Content</AnimatedPanel>);

		const element = screen.getByTestId("animated-panel");
		expect(element.className).toContain("opacity-100");
		expect(element.className).not.toContain("transition-all");
	});
});
