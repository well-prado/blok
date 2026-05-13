import { cancelRun, fetchScheduledDispatches } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface ScheduledDispatchQueryParams {
	/**
	 * Subset of statuses to return. When omitted, returns all three
	 * (`delayed`, `queued`, `debounced`). The backend ignores values
	 * outside this set.
	 */
	status?: Array<"delayed" | "queued" | "debounced">;
	workflowName?: string;
	limit?: number;
	offset?: number;
}

/**
 * Subscribes to `GET /__blok/scheduled` with a 3s poll — same cadence
 * as the regular runs list so the two views stay in lock-step when an
 * operator switches between them. The query key includes `params` so
 * filter changes refetch without thrashing the cache for the
 * unfiltered view.
 *
 * Unlike `useRuns`, this hook does NOT participate in `useEnvScope`
 * because the `scheduled_dispatches` table is global — `environment`
 * isn't a column there. If we add environment scoping at the dispatch
 * layer in the future, this hook is where it'd plug in.
 */
export function useScheduledDispatches(params?: ScheduledDispatchQueryParams) {
	return useQuery({
		queryKey: ["scheduled-dispatches", params],
		queryFn: () => fetchScheduledDispatches(params),
		refetchInterval: 3000,
	});
}

/**
 * Cancel a scheduled run. Reuses the regular cancel endpoint —
 * `POST /__blok/runs/:runId/cancel` handles delayed / queued /
 * debounced (and running) states uniformly. On success, invalidates
 * the `scheduled-dispatches` query so the row drops out of the list
 * within one poll cycle instead of waiting for the timer-driven
 * refresh.
 */
export function useCancelRun() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (runId: string) => cancelRun(runId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["scheduled-dispatches"] });
			void queryClient.invalidateQueries({ queryKey: ["runs"] });
		},
	});
}
