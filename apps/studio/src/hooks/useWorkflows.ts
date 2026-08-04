import {
	deleteWorkflowSample,
	fetchWorkflowDetail,
	fetchWorkflowStudio,
	fetchWorkflows,
	saveWorkflowStudio,
} from "@/lib/api";
import type { WorkflowStudioConfig } from "@/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

export function useWorkflowStudio(name: string) {
	return useQuery({
		queryKey: ["workflow-studio", name],
		queryFn: () => fetchWorkflowStudio(name),
		enabled: !!name,
	});
}

export function useSaveWorkflowStudio(name: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ config, baseEtag }: { config: WorkflowStudioConfig; baseEtag: string | null }) =>
			saveWorkflowStudio(name, config, baseEtag),
		onSuccess: (saved) => queryClient.setQueryData(["workflow-studio", name], saved),
	});
}

/**
 * #103 follow-up — delete the recorded sample so the next successful
 * run re-records. On success invalidates the workflow detail query so
 * the curl preview + `source` label refreshes to whatever resolves
 * next (author > inferred > empty, since the recorded row is gone).
 */
export function useDeleteWorkflowSample(name: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => deleteWorkflowSample(name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["workflow", name] });
		},
	});
}
