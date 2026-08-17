import { Header1, Header2, Header3 } from "@/components/primitives/Headers";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Headers", () => {
	it("renders each header at its own heading level", () => {
		render(
			<>
				<Header1>Runs</Header1>
				<Header2>Timeline</Header2>
				<Header3>Attempt 1</Header3>
			</>,
		);
		// The tag IS the API — the accessible heading outline is the assertion.
		expect(screen.getByRole("heading", { level: 1, name: "Runs" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { level: 2, name: "Timeline" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { level: 3, name: "Attempt 1" })).toBeInTheDocument();
	});

	it("applies the tone variant", () => {
		render(<Header2 tone="dimmed">Timeline</Header2>);
		// No semantic signal distinguishes tones, so exactly one discriminating class.
		expect(screen.getByRole("heading", { level: 2 })).toHaveClass("text-ink-dimmed");
	});

	it("ships no margin until spacing is opted into", () => {
		const { rerender } = render(<Header1>Runs</Header1>);
		expect(screen.getByRole("heading", { level: 1 })).not.toHaveClass("mb-2");
		rerender(<Header1 spacing>Runs</Header1>);
		expect(screen.getByRole("heading", { level: 1 })).toHaveClass("mb-2");
	});
});
