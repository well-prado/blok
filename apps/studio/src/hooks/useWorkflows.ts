import {
	deleteWorkflowSample,
	fetchNodeCatalog,
	fetchWorkflowDefinition,
	fetchWorkflowDetail,
	fetchWorkflowStudio,
	fetchWorkflows,
	saveWorkflowDefinition,
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
 * Phase 5.2 — the node catalog for the palette. The catalog only changes on
 * deploys, so cache it for the session.
 */
export function useNodeCatalog(enabled: boolean) {
	return useQuery({
		queryKey: ["node-catalog"],
		queryFn: fetchNodeCatalog,
		enabled,
		staleTime: 5 * 60 * 1000,
	});
}

/**
 * Phase 5.4 — apply a structural edit to the workflow definition. The
 * mutation fn re-reads the on-disk definition for a fresh etag, transforms
 * it, and saves; on success the workflow detail (definition → canvas DAG)
 * refetches.
 */
export function useEditWorkflowDefinition(name: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (transform: (definition: Record<string, unknown>) => Record<string, unknown>) => {
			const current = await fetchWorkflowDefinition(name);
			return saveWorkflowDefinition(name, transform(current.definition), current.etag);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["workflow", name] });
		},
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
