import { render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { Breadcrumbs } from "./Breadcrumbs";

// Mock Link from @tanstack/react-router
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		params,
		className,
	}: { children: React.ReactNode; to: string; params: Record<string, string>; className: string }) => (
		<a href={to} data-params={JSON.stringify(params)} className={className}>
			{children}
		</a>
	),
}));

describe("Breadcrumbs", () => {
	it("renders nothing if segments are empty", () => {
		const { container } = render(<Breadcrumbs segments={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders text for segments without 'to'", () => {
		render(<Breadcrumbs segments={[{ label: "Segment 1" }]} />);
		const span = screen.getByText("Segment 1");
		expect(span.tagName).toBe("SPAN");
	});

	it("renders links for segments with 'to'", () => {
		render(
			<Breadcrumbs
				segments={[
					{ label: "Home", to: "/" },
					{ label: "Runs", to: "/runs", params: { filter: "all" } },
				]}
			/>,
		);

		const homeLink = screen.getByRole("link", { name: "Home" });
		expect(homeLink).toHaveAttribute("href", "/");

		const runsLink = screen.getByRole("link", { name: "Runs" });
		expect(runsLink).toHaveAttribute("href", "/runs");
		expect(runsLink).toHaveAttribute("data-params", JSON.stringify({ filter: "all" }));
	});

	it("renders separators between segments", () => {
		const { container } = render(<Breadcrumbs segments={[{ label: "1" }, { label: "2" }, { label: "3" }]} />);
		// ChevronRight renders an svg. There should be 2 separators.
		const svgs = container.querySelectorAll("svg");
		expect(svgs.length).toBe(2);
	});
});
