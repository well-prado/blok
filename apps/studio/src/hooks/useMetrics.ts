import { addRunTags, fetchMetrics, fetchRunDiff, fetchTags, removeRunTag } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useMetrics(workflow?: string) {
	return useQuery({
		queryKey: ["metrics", workflow],
		queryFn: () => fetchMetrics(workflow),
		refetchInterval: 10000,
	});
}

export function useRunDiff(runIdA: string, runIdB: string) {
	return useQuery({
		queryKey: ["diff", runIdA, runIdB],
		queryFn: () => fetchRunDiff(runIdA, runIdB),
		enabled: !!runIdA && !!runIdB,
	});
}

export function useTags() {
	return useQuery({
		queryKey: ["tags"],
		queryFn: fetchTags,
		refetchInterval: 5000,
	});
}

export function useAddTags(runId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (tags: string[]) => addRunTags(runId, tags),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["run", runId] });
			queryClient.invalidateQueries({ queryKey: ["tags"] });
			queryClient.invalidateQueries({ queryKey: ["runs"] });
		},
	});
}

export function useRemoveTag(runId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (tag: string) => removeRunTag(runId, tag),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["run", runId] });
			queryClient.invalidateQueries({ queryKey: ["tags"] });
			queryClient.invalidateQueries({ queryKey: ["runs"] });
		},
	});
}
