import { deleteWorkflowSample, fetchWorkflowDetail, fetchWorkflows } from "@/lib/api";
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
