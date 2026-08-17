import { Badge, StatusBadge } from "@/components/primitives/Badge";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Badge", () => {
	it("renders its children", () => {
		render(<Badge>v1.2.0</Badge>);
		expect(screen.getByText("v1.2.0")).toBeInTheDocument();
	});

	it("applies the variant", () => {
		render(<Badge variant="accent">beta</Badge>);
		// Nothing semantic distinguishes badge variants, so exactly one class.
		expect(screen.getByText("beta")).toHaveClass("bg-accent/10");
	});

	it("applies the size row from the ladder", () => {
		render(<Badge size="sm">sm</Badge>);
		expect(screen.getByText("sm")).toHaveClass("h-7");
	});
});

describe("StatusBadge", () => {
	it("renders the label for the status", () => {
		render(<StatusBadge status="timedOut" />);
		expect(screen.getByText("Timed Out")).toBeInTheDocument();
	});

	it("uses the ink role for the label and the fill role for the dot", () => {
		const { container } = render(<StatusBadge status="failed" />);
		expect(screen.getByText(/Failed/)).toHaveClass("text-status-failed-ink");
		expect(container.querySelector('[aria-hidden="true"]')).toHaveClass("bg-status-failed");
	});

	it("hides the dot from assistive tech", () => {
		const { container } = render(<StatusBadge status="completed" />);
		expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
	});
});
