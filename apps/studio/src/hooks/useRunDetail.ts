import { fetchRunDetail } from "@/lib/api";
import { TERMINAL_RUN_EVENT_STATUS, TRANSIENT_RUN_EVENT_STATUS } from "@/lib/runEvents";
import { connectRunStream } from "@/lib/sse";
import { useConnectionStore } from "@/stores/connection";
import type { NodeRun, NodeRunErrorDetail, RunDetail, RunEvent, TraceLogEntry } from "@/types";
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
 * Tier 2 · sub-workflow lineage. Fetch the runs that were started by
 * `subworkflow:` steps inside the given parent run. Returns an empty
 * array when this run has no children.
 */
export function useSubRuns(runId: string) {
	return useQuery({
		queryKey: ["run", runId, "subruns"],
		queryFn: () => import("@/lib/api").then((m) => m.fetchSubRuns(runId)),
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
					// Terminal run events — the run is finished (set finishedAt + duration).
					case "RUN_COMPLETED":
					case "RUN_FAILED":
					case "RUN_CRASHED":
					case "RUN_TIMED_OUT":
					case "RUN_THROTTLED":
					case "RUN_CANCELLED":
					case "RUN_EXPIRED": {
						const status = TERMINAL_RUN_EVENT_STATUS[event.type];
						const isFailure = event.type === "RUN_FAILED" || event.type === "RUN_CRASHED";
						updated.run = {
							...updated.run,
							...(status ? { status } : {}),
							finishedAt: event.timestamp,
							durationMs: event.timestamp - updated.run.startedAt,
							...(isFailure && event.payload ? { error: event.payload as WorkflowRunError } : {}),
						};
						break;
					}

					// Transient run events — status changes but the run is NOT finished
					// (queued/delayed resume to running later; no finishedAt).
					case "RUN_QUEUED":
					case "RUN_DELAYED": {
						const status = TRANSIENT_RUN_EVENT_STATUS[event.type];
						if (status) updated.run = { ...updated.run, status };
						break;
					}

					case "NODE_STARTED": {
						const nodeId = event.nodeId || event.id;
						// Skip if this node already exists (REST fetch + SSE replay overlap)
						if (updated.nodes.some((n) => n.id === nodeId)) break;
						const newNode: NodeRun = {
							id: nodeId,
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

					// Tier 1 idempotency cache hit — the node short-circuited via the
					// cache. Mark it completed + attach the cache lineage (CACHED badge).
					case "NODE_CACHED": {
						const src = (event.payload as { source?: NodeRun["cached"] } | undefined)?.source;
						updated.nodes = updated.nodes.map((n) =>
							n.id === event.nodeId || n.nodeName === event.nodeName
								? { ...n, status: "completed" as const, finishedAt: event.timestamp, cached: src ?? n.cached }
								: n,
						);
						break;
					}

					// Tier 1 retry — a non-final attempt failed; append it to attempts[]
					// (the terminal NODE_FAILED still fires once retries are exhausted).
					case "NODE_ATTEMPT_FAILED": {
						const p = event.payload as { attempt?: number; error?: NodeRunErrorDetail } | undefined;
						updated.nodes = updated.nodes.map((n) =>
							n.id === event.nodeId || n.nodeName === event.nodeName
								? {
										...n,
										attempts: [
											...(n.attempts ?? []),
											{
												attempt: p?.attempt ?? (n.attempts?.length ?? 0) + 1,
												error: p?.error ?? ({ message: "attempt failed" } as NodeRunErrorDetail),
												timestamp: event.timestamp,
											},
										],
									}
								: n,
						);
						break;
					}

					case "LOG_ENTRY": {
						const logPayload = event.payload as Record<string, unknown> | undefined;
						if (logPayload) {
							// Skip if this log already exists (REST fetch + SSE replay overlap)
							if (updated.logs.some((l) => l.id === event.id)) break;
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

					case "NODE_PROGRESS": {
						// Phase 5 streaming frame: drives the live progress bar
						// + phase label in NodeDetail.tsx. Always overwrites any
						// previous progress on this node — only the latest frame
						// is preserved.
						const progressPayload = event.payload as Record<string, unknown> | undefined;
						if (!progressPayload) break;
						updated.nodes = updated.nodes.map((n) =>
							n.id === event.nodeId || n.nodeName === event.nodeName
								? {
										...n,
										progress: {
											percent: Math.max(0, Math.min(100, Number(progressPayload.percent ?? 0))),
											phase: (progressPayload.phase as string) || "",
											updatedAt: event.timestamp,
										},
									}
								: n,
						);
						break;
					}

					case "NODE_PARTIAL_RESULT": {
						// Phase 5 streaming frame: interim snapshot of an
						// in-flight node's output. Studio renders this as a
						// JSON viewer that the operator can expand to peek at
						// what the node has computed so far.
						const partialPayload = event.payload as Record<string, unknown> | undefined;
						if (!partialPayload) break;
						updated.nodes = updated.nodes.map((n) =>
							n.id === event.nodeId || n.nodeName === event.nodeName
								? {
										...n,
										partialResult: {
											snapshot: partialPayload.snapshot,
											updatedAt: event.timestamp,
										},
									}
								: n,
						);
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
