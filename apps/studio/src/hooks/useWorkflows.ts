import { useQuery } from "@tanstack/react-query";
import { fetchWorkflows, fetchWorkflowDetail } from "@/lib/api";

export function useWorkflows() {
  return useQuery({
    queryKey: ["workflows"],
    queryFn: fetchWorkflows,
    refetchInterval: 5000,
  });
}

export function useWorkflowDetail(name: string) {
  return useQuery({
    queryKey: ["workflow", name],
    queryFn: () => fetchWorkflowDetail(name),
    enabled: !!name,
  });
}
