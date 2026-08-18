import { BulkActionBar } from "@/components/primitives/BulkActionBar";
import { Button } from "@/components/primitives/Buttons";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("BulkActionBar", () => {
	it("renders nothing while the selection is empty", () => {
		const { container } = render(<BulkActionBar count={0} onClear={vi.fn()} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("announces the count politely and exposes the actions", () => {
		render(
			<BulkActionBar count={3} onClear={vi.fn()}>
				<Button size="sm">Replay</Button>
			</BulkActionBar>,
		);
		const bar = screen.getByRole("region", { name: "Bulk actions" });
		expect(bar).toHaveTextContent("3 selected");
		// Polite, not assertive: the count changes on every click.
		expect(screen.getByText("selected", { exact: false }).closest("p")).toHaveAttribute("aria-live", "polite");
		expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
	});

	it("clears from the keyboard", async () => {
		const onClear = vi.fn();
		const user = userEvent.setup();
		render(<BulkActionBar count={2} onClear={onClear} />);

		const clear = screen.getByRole("button", { name: "Clear" });
		clear.focus();
		await user.keyboard("{Enter}");
		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it("shows a VISIBLE cap message instead of warning to the console", () => {
		render(<BulkActionBar count={2} max={2} atMax onClear={vi.fn()} />);
		// The reference `console.warn`s and truncates the set silently, so the user
		// sees a selection they do not have (§2.14).
		expect(screen.getByText(/Selection limit of 2 reached/)).toBeVisible();
	});

	it("omits the cap message when the cap is not reached", () => {
		render(<BulkActionBar count={2} max={5} onClear={vi.fn()} />);
		expect(screen.queryByText(/Selection limit/)).not.toBeInTheDocument();
	});

	it("renders the caller's note next to the count", () => {
		render(<BulkActionBar count={4} onClear={vi.fn()} note={<span>· 2 non-HTTP, replay-skip</span>} />);
		expect(screen.getByText("· 2 non-HTTP, replay-skip")).toBeVisible();
	});
});
