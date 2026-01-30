import { useQuery } from "@tanstack/react-query";
import { fetchRuns, fetchWorkflowRuns } from "@/lib/api";

interface RunQueryParams {
  workflow?: string;
  status?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

export function useRuns(params?: RunQueryParams) {
  return useQuery({
    queryKey: ["runs", params],
    queryFn: () => fetchRuns(params),
    refetchInterval: 3000,
  });
}

export function useWorkflowRuns(name: string, params?: Omit<RunQueryParams, "workflow">) {
  return useQuery({
    queryKey: ["workflow-runs", name, params],
    queryFn: () => fetchWorkflowRuns(name, params),
    enabled: !!name,
    refetchInterval: 3000,
  });
}
