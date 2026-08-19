import { Skeleton } from "@/components/primitives/Skeleton";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Skeleton", () => {
	it("hides from assistive tech", () => {
		const { container } = render(<Skeleton />);
		expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
	});

	it("applies the motion-safe pulse class", () => {
		const { container } = render(<Skeleton />);
		expect(container.firstChild).toHaveClass("motion-safe:animate-pulse");
	});
});
