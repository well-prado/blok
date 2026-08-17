import { Toast } from "@/components/primitives/Toast";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Only the presentational half is unit-tested here: `NotificationToast` is the
// app-wired container (zustand store + router) and belongs to an integration test.
describe("Toast", () => {
	it("announces itself as a live region carrying the message", () => {
		render(<Toast variant="success" title="Run finished" message="wf-orders · 1.2s" />);
		const toast = screen.getByRole("status");
		expect(toast).toHaveTextContent("Run finished");
		expect(toast).toHaveTextContent("wf-orders · 1.2s");
	});

	it("hides the variant glyph from assistive tech", () => {
		const { container } = render(<Toast variant="error" title="Run failed" />);
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	});

	it("renders a plain title until onSelect makes it actionable", () => {
		const { rerender } = render(<Toast title="Run finished" />);
		expect(screen.queryByRole("button", { name: "Run finished" })).not.toBeInTheDocument();
		rerender(<Toast title="Run finished" onSelect={() => {}} />);
		expect(screen.getByRole("button", { name: "Run finished" })).toBeInTheDocument();
	});

	it("is operable from the keyboard — select then dismiss", async () => {
		const onSelect = vi.fn();
		const onDismiss = vi.fn();
		render(<Toast title="Run finished" onSelect={onSelect} onDismiss={onDismiss} />);

		await userEvent.tab();
		expect(screen.getByRole("button", { name: "Run finished" })).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		expect(onSelect).toHaveBeenCalledTimes(1);

		await userEvent.tab();
		expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
