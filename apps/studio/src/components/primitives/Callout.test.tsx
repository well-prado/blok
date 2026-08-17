import { Callout } from "@/components/primitives/Callout";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("Callout", () => {
	it("renders its title and body", () => {
		render(
			<Callout variant="warning" title="Rate limited">
				Retrying in 30s.
			</Callout>,
		);
		expect(screen.getByText("Rate limited")).toBeInTheDocument();
		expect(screen.getByText("Retrying in 30s.")).toBeInTheDocument();
	});

	it("hides the variant glyph from assistive tech", () => {
		const { container } = render(<Callout variant="error">Boom</Callout>);
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	});

	it("shows no dismiss control unless onDismiss is given", () => {
		render(<Callout>Nothing to do</Callout>);
		expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
	});

	it("calls onDismiss from the keyboard", async () => {
		const onDismiss = vi.fn();
		render(<Callout onDismiss={onDismiss}>Deploy finished</Callout>);
		await userEvent.tab();
		await userEvent.keyboard("{Enter}");
		expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
