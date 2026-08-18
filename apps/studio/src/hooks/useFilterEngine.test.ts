// @ts-nocheck
import { useNavigate, useSearch } from "@tanstack/react-router";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFilterEngine } from "./useFilterEngine";

vi.mock("@tanstack/react-router", () => ({
	useSearch: vi.fn(),
	useNavigate: vi.fn(),
}));

describe("useFilterEngine", () => {
	let mockNavigate: ReturnType<typeof vi.fn>;
	let currentSearch: Record<string, unknown>;

	beforeEach(() => {
		currentSearch = {};
		mockNavigate = vi.fn((opts) => {
			if (typeof opts.search === "function") {
				currentSearch = opts.search(currentSearch);
			} else {
				currentSearch = opts.search;
			}
		});

		vi.mocked(useSearch).mockImplementation(() => currentSearch);
		vi.mocked(useNavigate).mockReturnValue(mockNavigate);
	});

	it("returns EMPTY_FILTER initially when search is empty", () => {
		const { result } = renderHook(() => useFilterEngine());

		expect(result.current.filters).toEqual({
			status: [],
			workflow: [],
			triggerType: [],
			runtimeKind: [],
			node: [],
			tags: [],
			metadata: {},
			timePeriod: null,
			durationBucket: null,
		});
		expect(result.current.activeCount).toBe(0);
		expect(result.current.toApiParams()).toEqual({});
	});

	it("parses single string parameter into array for array fields", () => {
		currentSearch = { status: "completed" };
		const { result } = renderHook(() => useFilterEngine());
		expect(result.current.filters.status).toEqual(["completed"]);
	});

	it("parses comma-separated strings into array for array fields", () => {
		currentSearch = { status: "completed,failed" };
		const { result } = renderHook(() => useFilterEngine());
		expect(result.current.filters.status).toEqual(["completed", "failed"]);
	});

	it("parses metadata and timePeriod from valid JSON", () => {
		currentSearch = {
			metadata: '{"env":"prod"}',
			timePeriod: '{"type":"relative","value":"1h"}',
		};
		const { result } = renderHook(() => useFilterEngine());

		expect(result.current.filters.metadata).toEqual({ env: "prod" });
		expect(result.current.filters.timePeriod).toEqual({ type: "relative", value: "1h" });
		expect(result.current.activeCount).toBe(2);
	});

	it("safely handles invalid JSON for metadata/timePeriod", () => {
		currentSearch = {
			metadata: "{invalid_json",
			timePeriod: "null",
		};
		const { result } = renderHook(() => useFilterEngine());

		expect(result.current.filters.metadata).toEqual({});
		expect(result.current.filters.timePeriod).toBeNull();
	});

	it("setFilter correctly updates an array field and removes offset", () => {
		currentSearch = { status: "completed", offset: "10" };
		const { result } = renderHook(() => useFilterEngine());

		act(() => {
			result.current.setFilter("status", ["completed", "failed"]);
		});

		expect(mockNavigate).toHaveBeenCalledWith({
			search: expect.any(Function),
			replace: true,
		});

		expect(currentSearch).toEqual({ status: "completed,failed" });
	});

	it("setFilter clears field if value is empty array", () => {
		currentSearch = { status: "completed" };
		const { result } = renderHook(() => useFilterEngine());

		act(() => {
			result.current.setFilter("status", []);
		});

		expect(currentSearch).toEqual({});
	});

	it("setFilter updates metadata properly", () => {
		const { result } = renderHook(() => useFilterEngine());

		act(() => {
			result.current.setFilter("metadata", { env: "prod" });
		});

		expect(currentSearch).toEqual({ metadata: '{"env":"prod"}' });
	});

	it("clearFilter removes specific field and offset", () => {
		currentSearch = { status: "completed", workflow: "w1", offset: "10" };
		const { result } = renderHook(() => useFilterEngine());

		act(() => {
			result.current.clearFilter("status");
		});

		expect(currentSearch).toEqual({ workflow: "w1" });
	});

	it("clearAll removes all filter keys and offset", () => {
		currentSearch = {
			status: "completed",
			metadata: '{"env":"prod"}',
			offset: "10",
			sort: "duration", // Should NOT be cleared
		};
		const { result } = renderHook(() => useFilterEngine());

		act(() => {
			result.current.clearAll();
		});

		// Only `sort` should remain
		expect(currentSearch).toEqual({ sort: "duration" });
	});

	it("toApiParams formats the query correctly for api.ts", () => {
		currentSearch = {
			status: "completed,failed",
			tags: "a,b",
			metadata: '{"k1":"v1"}',
			workflow: "w1",
		};
		const { result } = renderHook(() => useFilterEngine());

		const params = result.current.toApiParams();
		expect(params).toEqual({
			status: "completed,failed",
			workflow: "w1",
			tags: ["a", "b"],
			metadata: { k1: "v1" },
		});
	});
});
