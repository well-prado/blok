import { LoadingBarDivider } from "@/components/primitives/LoadingBarDivider";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("LoadingBarDivider", () => {
	it("hides from assistive tech", () => {
		const { container } = render(<LoadingBarDivider />);
		expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
	});

	it("shows the animated bar when loading", () => {
		const { container } = render(<LoadingBarDivider isLoading={true} />);
		expect(container.querySelector(".motion-safe\\:animate-grow-bar")).toBeInTheDocument();
	});

	it("hides the animated bar when not loading", () => {
		const { container } = render(<LoadingBarDivider isLoading={false} />);
		expect(container.querySelector(".animate-grow-bar")).not.toBeInTheDocument();
	});
});
