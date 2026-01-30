import { connectGlobalStream } from "@/lib/sse";
import { useConnectionStore } from "@/stores/connection";
import { useNotificationStore } from "@/stores/notifications";
import type { RunEvent } from "@/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * Subscribe to the global SSE stream for live dashboard updates.
 * Invalidates relevant queries when events arrive.
 * Emits notifications on run completions/failures.
 */
export function useGlobalStream(enabled = true) {
	const queryClient = useQueryClient();
	const { setStatus, incrementStreams, decrementStreams } = useConnectionStore();
	const addNotification = useNotificationStore((s) => s.addNotification);
	const notificationsEnabled = useNotificationStore((s) => s.enabled);

	useEffect(() => {
		if (!enabled) return;

		incrementStreams();
		setStatus("connecting");

		const disconnect = connectGlobalStream({
			onEvent: (event: RunEvent) => {
				// Invalidate workflow and run queries to trigger refetch
				queryClient.invalidateQueries({ queryKey: ["workflows"] });
				queryClient.invalidateQueries({ queryKey: ["runs"] });

				// Emit notifications for run completions/failures
				if (notificationsEnabled) {
					if (event.type === "RUN_COMPLETED") {
						const payload = event.payload as Record<string, unknown> | undefined;
						const durationMs = payload?.durationMs as number | undefined;
						addNotification({
							type: "success",
							title: `${event.workflowName} completed`,
							message: durationMs ? `Finished in ${formatMs(durationMs)}` : "Run completed successfully",
							runId: event.runId,
							workflowName: event.workflowName,
						});
					} else if (event.type === "RUN_FAILED") {
						const payload = event.payload as Record<string, { message?: string }> | undefined;
						const errorMsg = payload?.error?.message;
						addNotification({
							type: "error",
							title: `${event.workflowName} failed`,
							message: errorMsg || "Run failed with an error",
							runId: event.runId,
							workflowName: event.workflowName,
						});
					}
				}
			},
			onOpen: () => setStatus("connected"),
			onError: () => setStatus("error"),
		});

		return () => {
			disconnect();
			decrementStreams();
		};
	}, [enabled, queryClient, setStatus, incrementStreams, decrementStreams, addNotification, notificationsEnabled]);
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}
