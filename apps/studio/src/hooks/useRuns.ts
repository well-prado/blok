import { fetchRuns, fetchWorkflowRuns } from "@/lib/api";
import { useEnvScope } from "@/stores/envScope";
import { useQuery } from "@tanstack/react-query";

interface RunQueryParams {
	workflow?: string;
	status?: string;
	limit?: number;
	offset?: number;
	sort?: string;
}

/**
 * Phase 2.1 · environment scoping. Every list view subscribes to
 * `useEnvScope.current` so switching the EnvChip in the sidebar
 * automatically refetches scoped lists. The query-key includes `env` so
 * each scope has its own cached page — switching back to a previous env
 * shows results instantly without an extra round-trip.
 *
 * The runner's `/runs` endpoint defaults missing `environment` columns
 * to `"production"`, so legacy data still surfaces under the default
 * scope without a backfill.
 */
export function useRuns(params?: RunQueryParams) {
	const env = useEnvScope((s) => s.current);
	return useQuery({
		queryKey: ["runs", env, params],
		queryFn: () => fetchRuns({ ...params, env }),
		refetchInterval: 3000,
	});
}

export function useWorkflowRuns(name: string, params?: Omit<RunQueryParams, "workflow">) {
	const env = useEnvScope((s) => s.current);
	return useQuery({
		queryKey: ["workflow-runs", env, name, params],
		queryFn: () => fetchWorkflowRuns(name, { ...params, env }),
		enabled: !!name,
		refetchInterval: 3000,
	});
}
