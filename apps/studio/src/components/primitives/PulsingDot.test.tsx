import { PulsingDot } from "@/components/primitives/PulsingDot";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("PulsingDot", () => {
	it("renders with a screen-reader label", () => {
		render(<PulsingDot label="System healthy" />);
		// The entire dot container contains the text and has no specific role
		expect(screen.getByText("System healthy")).toBeInTheDocument();
	});

	it("can hide the label completely", () => {
		const { container } = render(<PulsingDot label={null} />);
		expect(container).toHaveTextContent("");
	});

	it("hides the decorative dot from assistive tech", () => {
		const { container } = render(<PulsingDot />);
		expect(container.querySelector("span[aria-hidden='true']")).toBeInTheDocument();
	});

	it("stops pulsing when isPulsing is false", () => {
		const { container } = render(<PulsingDot isPulsing={false} />);
		expect(container.querySelector(".animate-ping")).not.toBeInTheDocument();
	});
});
