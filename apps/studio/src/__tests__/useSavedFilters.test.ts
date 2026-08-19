import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSaveCurrentFilter, useSavedFilters } from "../hooks/useSavedFilters";
import * as api from "../lib/api";

vi.mock("../lib/api", () => ({
	fetchSavedFilters: vi.fn(),
	upsertSavedFilter: vi.fn(),
	deleteSavedFilter: vi.fn(),
}));

describe("useSavedFilters", () => {
	it("returns empty array initially", () => {
		const queryClient = new QueryClient();
		const wrapper = ({ children }: any) => createElement(QueryClientProvider, { client: queryClient }, children);
		vi.mocked(api.fetchSavedFilters).mockResolvedValue({ filters: [] });

		const { result } = renderHook(() => useSavedFilters(), { wrapper });
		expect(result.current).toEqual([]);
	});

	it("useSaveCurrentFilter maps FilterState to SaveFilterInput correctly", async () => {
		const queryClient = new QueryClient();
		const wrapper = ({ children }: any) => createElement(QueryClientProvider, { client: queryClient }, children);
		vi.mocked(api.upsertSavedFilter).mockResolvedValue({} as any);

		const { result } = renderHook(() => useSaveCurrentFilter(), { wrapper });

		const mockFilterState = {
			status: ["completed"],
			workflow: ["test-wf"],
			triggerType: ["http"],
			runtimeKind: ["nodejs"],
			node: ["step1"],
			tags: ["tag1"],
			metadata: { key1: "value1" },
			timePeriod: { type: "relative", value: "24h" } as const,
			durationBucket: "1s",
		};

		await act(async () => {
			await result.current("My Filter", mockFilterState);
		});

		expect(api.upsertSavedFilter).toHaveBeenCalledWith({
			name: "My Filter",
			status: ["completed"],
			workflow: ["test-wf"],
			triggerType: ["http"],
			runtimeKind: ["nodejs"],
			node: ["step1"],
			tags: ["tag1"],
			metadata: { key1: "value1" },
			timePeriod: { type: "relative", value: "24h" },
			durationBucket: "1s",
		});
	});
});
