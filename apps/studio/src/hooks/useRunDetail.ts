import { fetchRunDetail } from "@/lib/api";
import { connectRunStream } from "@/lib/sse";
import { useConnectionStore } from "@/stores/connection";
import type { NodeRun, RunDetail, RunEvent, TraceLogEntry } from "@/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

export function useRunDetail(runId: string) {
	return useQuery({
		queryKey: ["run", runId],
		queryFn: () => fetchRunDetail(runId),
		enabled: !!runId,
	});
}

/**
 * Subscribe to SSE stream for a run and update the TanStack Query cache
 * in real-time as events arrive.
 */
export function useTraceStream(runId: string) {
	const queryClient = useQueryClient();
	// Use individual selectors for stable references (see useGlobalStream.ts for explanation)
	const incrementStreams = useConnectionStore((s) => s.incrementStreams);
	const decrementStreams = useConnectionStore((s) => s.decrementStreams);
	const setStatus = useConnectionStore((s) => s.setStatus);

	const handleEvent = useCallback(
		(event: RunEvent) => {
			queryClient.setQueryData<RunDetail>(["run", runId], (old) => {
				if (!old) return old;
				const updated = { ...old };

				switch (event.type) {
					case "RUN_COMPLETED":
					case "RUN_FAILED":
						updated.run = {
							...updated.run,
							status: event.type === "RUN_COMPLETED" ? "completed" : "failed",
							finishedAt: event.timestamp,
							durationMs: event.timestamp - updated.run.startedAt,
							...(event.type === "RUN_FAILED" && event.payload ? { error: event.payload as WorkflowRunError } : {}),
						};
						break;

					case "NODE_STARTED": {
						const newNode: NodeRun = {
							id: event.nodeId || event.id,
							runId,
							nodeName: event.nodeName || "",
							nodeType: (event.payload as Record<string, string>)?.nodeType || "unknown",
							runtimeKind: (event.payload as Record<string, string>)?.runtimeKind,
							status: "running",
							startedAt: event.timestamp,
							depth: ((event.payload as Record<string, number>)?.depth as number) || 0,
							stepIndex: ((event.payload as Record<string, number>)?.stepIndex as number) || 0,
						};
						updated.nodes = [...updated.nodes, newNode];
						updated.run = {
							...updated.run,
							status: "running",
						};
						break;
					}

					case "NODE_COMPLETED": {
						updated.nodes = updated.nodes.map((n) =>
							n.id === event.nodeId || n.nodeName === event.nodeName
								? {
										...n,
										status: "completed" as const,
										finishedAt: event.timestamp,
										durationMs: event.timestamp - n.startedAt,
										outputs: (event.payload as Record<string, unknown>)?.outputs,
										metrics: (event.payload as Record<string, unknown>)?.metrics as NodeRun["metrics"],
									}
								: n,
						);
						updated.run = {
							...updated.run,
							completedNodes: updated.run.completedNodes + 1,
						};
						break;
					}

					case "NODE_FAILED": {
						updated.nodes = updated.nodes.map((n) =>
							n.id === event.nodeId || n.nodeName === event.nodeName
								? {
										...n,
										status: "failed" as const,
										finishedAt: event.timestamp,
										durationMs: event.timestamp - n.startedAt,
										error: event.payload as NodeRun["error"],
									}
								: n,
						);
						break;
					}

					case "NODE_SKIPPED": {
						updated.nodes = updated.nodes.map((n) =>
							n.id === event.nodeId || n.nodeName === event.nodeName ? { ...n, status: "skipped" as const } : n,
						);
						break;
					}

					case "LOG_ENTRY": {
						const logPayload = event.payload as Record<string, unknown> | undefined;
						if (logPayload) {
							const logEntry: TraceLogEntry = {
								id: event.id,
								runId,
								nodeId: event.nodeId,
								nodeName: event.nodeName,
								level: (logPayload.level as TraceLogEntry["level"]) || "info",
								message: (logPayload.message as string) || "",
								timestamp: event.timestamp,
								data: logPayload.data as Record<string, unknown>,
							};
							updated.logs = [...updated.logs, logEntry];
						}
						break;
					}
				}

				return updated;
			});
		},
		[queryClient, runId],
	);

	useEffect(() => {
		if (!runId) return;

		incrementStreams();
		setStatus("connecting");

		const disconnect = connectRunStream(runId, {
			onEvent: handleEvent,
			onOpen: () => setStatus("connected"),
			onEnd: () => {
				setStatus("connected");
				decrementStreams();
				// Refetch for final state
				queryClient.invalidateQueries({ queryKey: ["run", runId] });
				queryClient.invalidateQueries({ queryKey: ["runs"] });
				queryClient.invalidateQueries({ queryKey: ["workflows"] });
			},
			onError: () => setStatus("error"),
		});

		return () => {
			disconnect();
			decrementStreams();
		};
	}, [runId, handleEvent, incrementStreams, decrementStreams, setStatus, queryClient]);
}

type WorkflowRunError = { message: string; code?: string; stack?: string };
