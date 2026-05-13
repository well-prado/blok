import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

import { RunFilters } from "@/components/runs/RunFilters";
// Simple components that don't need router context
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { JsonViewer } from "@/components/shared/JsonViewer";
import { StatusBadge } from "@/components/shared/StatusBadge";

/**
 * RunFilters now reads saved filters via React Query (E2). Wrap it
 * in a fresh client per test so the saved-filters query mounts
 * without hitting the network — `fetchSavedFilters()` will throw in
 * jsdom which the hook treats as "no data yet" (returns `[]`).
 */
function renderWithQuery(ui: React.ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("StatusBadge", () => {
	it("renders completed status", () => {
		render(<StatusBadge status="completed" />);
		expect(screen.getByText("Completed")).toBeInTheDocument();
	});

	it("renders running status", () => {
		render(<StatusBadge status="running" />);
		expect(screen.getByText("Running")).toBeInTheDocument();
	});

	it("renders failed status", () => {
		render(<StatusBadge status="failed" />);
		expect(screen.getByText("Failed")).toBeInTheDocument();
	});

	it("renders pending status", () => {
		render(<StatusBadge status="pending" />);
		expect(screen.getByText("Pending")).toBeInTheDocument();
	});

	it("has aria-hidden dot", () => {
		const { container } = render(<StatusBadge status="completed" />);
		const dot = container.querySelector('[aria-hidden="true"]');
		expect(dot).toBeInTheDocument();
	});
});

describe("RunFilters", () => {
	it("renders all status options including new Tier 2 statuses", () => {
		renderWithQuery(<RunFilters status="" onStatusChange={() => {}} />);
		// Status select renders option text; getAllByText handles dupes if any.
		expect(screen.getByText("All")).toBeInTheDocument();
		expect(screen.getByText("Running")).toBeInTheDocument();
		expect(screen.getByText("Completed")).toBeInTheDocument();
		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(screen.getByText("Throttled")).toBeInTheDocument();
		expect(screen.getByText("Delayed")).toBeInTheDocument();
		expect(screen.getByText("Crashed")).toBeInTheDocument();
		expect(screen.getByText("Timed Out")).toBeInTheDocument();
	});

	it("calls onStatusChange when selecting a status (Tier 2 quick-wins)", async () => {
		const user = userEvent.setup();
		const handleChange = vi.fn();
		renderWithQuery(<RunFilters status="" onStatusChange={handleChange} />);

		// Status select is the first combobox; the second is the Saved Filters
		// dropdown added in Bundle B. Identify by its current value (empty
		// string for "All").
		const selects = screen.getAllByRole("combobox");
		const statusSelect = selects[0];
		if (!statusSelect) throw new Error("status select not found");
		await user.selectOptions(statusSelect, "running");
		expect(handleChange).toHaveBeenCalledWith("running");

		await user.selectOptions(statusSelect, "failed");
		expect(handleChange).toHaveBeenCalledWith("failed");
	});

	it("renders tags and metadata text inputs", () => {
		renderWithQuery(<RunFilters status="" onStatusChange={() => {}} />);
		expect(screen.getByPlaceholderText("user-123, premium")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("tier=premium, plan=pro")).toBeInTheDocument();
	});
});

describe("JsonViewer", () => {
	it("renders null for null data", () => {
		render(<JsonViewer data={null} />);
		expect(screen.getByText("null")).toBeInTheDocument();
	});

	it("renders object properties", () => {
		render(<JsonViewer data={{ name: "test", count: 42 }} />);
		expect(screen.getByText('"name"')).toBeInTheDocument();
		expect(screen.getByText('"test"')).toBeInTheDocument();
	});

	it("renders array data", () => {
		render(<JsonViewer data={[1, 2, 3]} />);
		expect(screen.getByText("1")).toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
		expect(screen.getByText("3")).toBeInTheDocument();
	});

	it("has copy button with aria-label", () => {
		render(<JsonViewer data={{ test: true }} />);
		const copyButton = screen.getByRole("button", { name: "Copy to clipboard" });
		expect(copyButton).toBeInTheDocument();
	});

	it("renders boolean values", () => {
		render(<JsonViewer data={{ active: true }} />);
		expect(screen.getByText("true")).toBeInTheDocument();
	});
});

describe("ErrorBoundary", () => {
	it("renders children when no error", () => {
		render(
			<ErrorBoundary>
				<div>Normal content</div>
			</ErrorBoundary>,
		);
		expect(screen.getByText("Normal content")).toBeInTheDocument();
	});

	it("renders error UI when child throws", () => {
		// Suppress console.error for expected error
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		function ThrowingComponent(): React.ReactNode {
			throw new Error("Test error");
		}

		render(
			<ErrorBoundary>
				<ThrowingComponent />
			</ErrorBoundary>,
		);

		expect(screen.getByText("Something went wrong")).toBeInTheDocument();
		expect(screen.getByText("Test error")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

		consoleSpy.mockRestore();
	});

	it("recovers from error on retry", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const user = userEvent.setup();
		let shouldThrow = true;

		function MaybeThrow() {
			if (shouldThrow) throw new Error("Boom");
			return <div>Recovered</div>;
		}

		render(
			<ErrorBoundary>
				<MaybeThrow />
			</ErrorBoundary>,
		);

		expect(screen.getByText("Something went wrong")).toBeInTheDocument();

		shouldThrow = false;
		await user.click(screen.getByRole("button", { name: /retry/i }));

		expect(screen.getByText("Recovered")).toBeInTheDocument();

		consoleSpy.mockRestore();
	});

	it("renders custom fallback when provided", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		function ThrowingComponent(): React.ReactNode {
			throw new Error("Test");
		}

		render(
			<ErrorBoundary fallback={<div>Custom fallback</div>}>
				<ThrowingComponent />
			</ErrorBoundary>,
		);

		expect(screen.getByText("Custom fallback")).toBeInTheDocument();

		consoleSpy.mockRestore();
	});
});
