import { type SaveFilterInput, deleteSavedFilter, fetchSavedFilters, upsertSavedFilter } from "@/lib/api";
import type { SavedFilter } from "@/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const QUERY_KEY = ["saved-filters"] as const;

/**
 * E2 · server-side saved filters for the runs list. Replaces the
 * pre-#101 localStorage shim with a `GET /__blok/saved-filters`-backed
 * query. Polls every 15s so a Save in another tab / device shows up
 * here without a refresh.
 *
 * Returns the filters array directly (empty when loading / on error)
 * so the consuming component doesn't have to thread `data` /
 * `isLoading` / `error` through every callsite.
 */
export function useSavedFilters(): SavedFilter[] {
	const { data } = useQuery({
		queryKey: QUERY_KEY,
		queryFn: () => fetchSavedFilters().then((r) => r.filters),
		refetchInterval: 15_000,
		staleTime: 5_000,
	});
	return data ?? [];
}

/**
 * Upsert a saved filter. The endpoint matches on `name` (UNIQUE)
 * server-side, so re-using a name overwrites the row + preserves its
 * id/createdAt. Invalidates the list on success so the dropdown
 * re-renders with the new entry pinned to the top.
 */
export function useUpsertSavedFilter() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: SaveFilterInput) => upsertSavedFilter(input),
		onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
	});
}

/**
 * Delete a saved filter by name. Mirrors the legacy delete-by-name
 * semantics callers already use. Invalidates the list on success.
 */
export function useDeleteSavedFilter() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => deleteSavedFilter(name),
		onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
	});
}
