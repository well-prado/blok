import { fetchRoutingDiagnostics } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

/**
 * Subscribes to `GET /__blok/routing` so Studio can render a banner
 * when the HTTP trigger dropped workflows due to route-table collisions
 * (or other boot-time route-build problems).
 *
 * Routing diagnostics are populated once at trigger boot; they only
 * change when the trigger rescans (HMR / restart). A long 30s poll is
 * plenty — the data is effectively static between scans.
 */
export function useRoutingDiagnostics() {
	return useQuery({
		queryKey: ["routing-diagnostics"],
		queryFn: () => fetchRoutingDiagnostics(),
		refetchInterval: 30_000,
		staleTime: 10_000,
	});
}
