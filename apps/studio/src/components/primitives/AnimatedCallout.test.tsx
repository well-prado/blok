import * as useReducedMotionHook from "@/hooks/use-reduced-motion";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedCallout } from "./AnimatedCallout";

vi.mock("@/hooks/use-reduced-motion", () => ({
	useReducedMotion: vi.fn(),
}));

describe("AnimatedCallout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(useReducedMotionHook.useReducedMotion).mockReturnValue(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("renders children when isVisible is true", () => {
		render(<AnimatedCallout isVisible={true}>Hello</AnimatedCallout>);
		expect(screen.getByText("Hello")).toBeInTheDocument();
	});

	it("applies entry animation classes initially", () => {
		render(
			<AnimatedCallout isVisible={true} slideDirection="up">
				Hello
			</AnimatedCallout>,
		);
		const element = screen.getByTestId("animated-callout");
		expect(element.className).toContain("opacity-0");
		expect(element.className).toContain("translate-y-4");
	});

	it("transitions to visible state after mount", () => {
		render(<AnimatedCallout isVisible={true}>Hello</AnimatedCallout>);
		const element = screen.getByTestId("animated-callout");

		act(() => {
			vi.advanceTimersByTime(20);
		});

		expect(element.className).toContain("opacity-100");
		expect(element.className).toContain("translate-y-0");
		expect(element.className).not.toContain("opacity-0");
	});

	it("skips animation if prefers-reduced-motion is true", () => {
		vi.mocked(useReducedMotionHook.useReducedMotion).mockReturnValue(true);
		render(<AnimatedCallout isVisible={true}>Hello</AnimatedCallout>);

		const element = screen.getByTestId("animated-callout");
		expect(element.className).toContain("opacity-100");
		expect(element.className).not.toContain("transition-all");
		expect(element.className).not.toContain("opacity-0");
	});

	it("delays unmount when isVisible becomes false", () => {
		const { rerender } = render(
			<AnimatedCallout isVisible={true} unmountDelay={300}>
				Hello
			</AnimatedCallout>,
		);

		act(() => {
			vi.advanceTimersByTime(20);
		});

		rerender(
			<AnimatedCallout isVisible={false} unmountDelay={300}>
				Hello
			</AnimatedCallout>,
		);

		const element = screen.getByTestId("animated-callout");
		expect(element).toBeInTheDocument();
		expect(element.className).toContain("opacity-0");

		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(screen.queryByText("Hello")).not.toBeInTheDocument();
	});
});
