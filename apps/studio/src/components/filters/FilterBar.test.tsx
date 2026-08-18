// @ts-nocheck
import { useFilterEngine } from "@/hooks/useFilterEngine";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar";

// Mock the hook
vi.mock("@/hooks/useFilterEngine", () => ({
	useFilterEngine: vi.fn(),
}));

// Mock the TimePeriodFilter so it doesn't complain about icons or popovers
vi.mock("./SavedFilterSelect", () => ({
	SavedFilterSelect: () => <div data-testid="saved-filter-select">SavedFilterSelect</div>,
}));

vi.mock("./TimePeriodFilter", () => ({
	TimePeriodFilter: ({ onChange }: Record<string, unknown> & { onChange: (val: unknown) => void }) => (
		<button type="button" data-testid="time-period" onClick={() => onChange({ type: "relative", value: "1h" })}>
			Time Period
		</button>
	),
}));

// Mock the FilterMenu
vi.mock("./FilterMenu", () => ({
	FilterMenu: ({ onSelect }: Record<string, unknown> & { onSelect: (key: string, val: string) => void }) => (
		<button type="button" data-testid="filter-menu" onClick={() => onSelect("status", "failed")}>
			Filter...
		</button>
	),
}));

describe("FilterBar", () => {
	const mockSetFilter = vi.fn();
	const mockClearFilter = vi.fn();
	const mockClearAll = vi.fn();

	const defaultFilters = {
		status: [],
		workflow: [],
		triggerType: [],
		runtimeKind: [],
		node: [],
		tags: [],
		metadata: {},
		timePeriod: null,
		durationBucket: null,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		(useFilterEngine as unknown as import("vitest").Mock).mockReturnValue({
			filters: defaultFilters,
			setFilter: mockSetFilter,
			clearFilter: mockClearFilter,
			clearAll: mockClearAll,
			activeCount: 0,
		});
	});

	it("renders filter menu and time period filter", () => {
		render(<FilterBar />);
		expect(screen.getByTestId("filter-menu")).toBeInTheDocument();
		expect(screen.getByTestId("time-period")).toBeInTheDocument();
		expect(screen.queryByText("Clear all")).not.toBeInTheDocument();
	});

	it("renders clear all button when filters are active", () => {
		(useFilterEngine as unknown as import("vitest").Mock).mockReturnValue({
			filters: { ...defaultFilters, status: ["failed"] },
			setFilter: mockSetFilter,
			clearFilter: mockClearFilter,
			clearAll: mockClearAll,
			activeCount: 1,
		});
		render(<FilterBar />);
		expect(screen.getByText("Clear all")).toBeInTheDocument();
	});

	it("renders chips for active filters", () => {
		(useFilterEngine as unknown as import("vitest").Mock).mockReturnValue({
			filters: {
				...defaultFilters,
				status: ["failed", "completed"],
				metadata: { tenant: "acme" },
			},
			setFilter: mockSetFilter,
			clearFilter: mockClearFilter,
			clearAll: mockClearAll,
			activeCount: 3,
		});
		render(<FilterBar />);

		expect(screen.getAllByText("Status:")).toHaveLength(2);
		expect(screen.getByText("failed")).toBeInTheDocument();
		expect(screen.getByText("completed")).toBeInTheDocument();

		expect(screen.getByText("Metadata:")).toBeInTheDocument();
		expect(screen.getByText("tenant:acme")).toBeInTheDocument();
	});

	it("handles removing an array filter item", () => {
		(useFilterEngine as unknown as import("vitest").Mock).mockReturnValue({
			filters: { ...defaultFilters, status: ["failed", "completed"] },
			setFilter: mockSetFilter,
			clearFilter: mockClearFilter,
			clearAll: mockClearAll,
			activeCount: 2,
		});
		render(<FilterBar />);

		const removeBtns = screen.getAllByRole("button", { name: /Remove Status filter/i });
		fireEvent.click(removeBtns[0]);

		expect(mockSetFilter).toHaveBeenCalledWith("status", ["completed"]);
	});

	it("clears the array filter completely if removing the last item", () => {
		(useFilterEngine as unknown as import("vitest").Mock).mockReturnValue({
			filters: { ...defaultFilters, status: ["failed"] },
			setFilter: mockSetFilter,
			clearFilter: mockClearFilter,
			clearAll: mockClearAll,
			activeCount: 1,
		});
		render(<FilterBar />);

		const removeBtn = screen.getByRole("button", { name: /Remove Status filter/i });
		fireEvent.click(removeBtn);

		expect(mockClearFilter).toHaveBeenCalledWith("status");
	});

	it("handles removing metadata", () => {
		(useFilterEngine as unknown as import("vitest").Mock).mockReturnValue({
			filters: { ...defaultFilters, metadata: { tenant: "acme", env: "prod" } },
			setFilter: mockSetFilter,
			clearFilter: mockClearFilter,
			clearAll: mockClearAll,
			activeCount: 2,
		});
		render(<FilterBar />);

		const removeBtns = screen.getAllByRole("button", { name: /Remove Metadata filter/i });
		fireEvent.click(removeBtns[0]);

		expect(mockSetFilter).toHaveBeenCalledWith("metadata", { env: "prod" });
	});

	it("clears all metadata when the last item is removed", () => {
		(useFilterEngine as unknown as import("vitest").Mock).mockReturnValue({
			filters: { ...defaultFilters, metadata: { tenant: "acme" } },
			setFilter: mockSetFilter,
			clearFilter: mockClearFilter,
			clearAll: mockClearAll,
			activeCount: 1,
		});
		render(<FilterBar />);

		const removeBtn = screen.getByRole("button", { name: /Remove Metadata filter/i });
		fireEvent.click(removeBtn);

		expect(mockClearFilter).toHaveBeenCalledWith("metadata");
	});

	it("calls clearAll when clear all button is clicked", () => {
		(useFilterEngine as unknown as import("vitest").Mock).mockReturnValue({
			filters: { ...defaultFilters, status: ["failed"] },
			setFilter: mockSetFilter,
			clearFilter: mockClearFilter,
			clearAll: mockClearAll,
			activeCount: 1,
		});
		render(<FilterBar />);

		fireEvent.click(screen.getByText("Clear all"));
		expect(mockClearAll).toHaveBeenCalled();
	});
});
