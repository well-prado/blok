import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatingArrow } from "./AnimatingArrow";

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(), // deprecated
		removeListener: vi.fn(), // deprecated
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
});

describe("AnimatingArrow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders correctly with animations enabled by default", () => {
		const { container } = render(<AnimatingArrow />);
		const paths = container.querySelectorAll("path");
		expect(paths).toHaveLength(2);
		// Should have animation classes
		expect(paths[0]?.className.baseVal).toContain("transition-transform");
	});

	it("disables animation when prefers-reduced-motion is true", () => {
		window.matchMedia = vi.fn().mockImplementation((query) => ({
			matches: query === "(prefers-reduced-motion: reduce)",
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));

		const { container } = render(<AnimatingArrow />);
		const paths = container.querySelectorAll("path");
		expect(paths).toHaveLength(2);
		// Should not have animation classes
		expect(paths[0]?.className.baseVal).toBe("");
	});
});
