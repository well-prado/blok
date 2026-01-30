import { connectGlobalStream } from "@/lib/sse";
import { useConnectionStore } from "@/stores/connection";
import { useLiveFeedStore } from "@/stores/liveFeed";
import { useNotificationStore } from "@/stores/notifications";
import type { RunEvent } from "@/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * Subscribe to the global SSE stream for live dashboard updates.
 * Should be called once in the root layout so the connection persists
 * across page navigations.
 *
 * - Debounces query invalidations to avoid thundering-herd HTTP refetches.
 * - Pushes events to the shared live feed store for LiveFeed component.
 * - Emits notifications on run completions/failures.
 */
export function useGlobalStream(enabled = true) {
	const queryClient = useQueryClient();
	const { setStatus, incrementStreams, decrementStreams } = useConnectionStore();
	const addNotification = useNotificationStore((s) => s.addNotification);
	const notificationsEnabled = useNotificationStore((s) => s.enabled);
	const pushEvent = useLiveFeedStore((s) => s.pushEvent);
	const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!enabled) return;

		incrementStreams();
		setStatus("connecting");

		// Batch query invalidations in 500ms windows to avoid
		// firing N*2 HTTP requests per second during rapid events.
		const scheduleInvalidation = () => {
			if (invalidateTimer.current) return;
			invalidateTimer.current = setTimeout(() => {
				invalidateTimer.current = null;
				queryClient.invalidateQueries({ queryKey: ["workflows"] });
				queryClient.invalidateQueries({ queryKey: ["runs"] });
			}, 500);
		};

		const disconnect = connectGlobalStream({
			onEvent: (event: RunEvent) => {
				scheduleInvalidation();

				// Push to shared live feed store (consumed by LiveFeed component)
				pushEvent(event);

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
			if (invalidateTimer.current) {
				clearTimeout(invalidateTimer.current);
				invalidateTimer.current = null;
			}
		};
	}, [enabled, queryClient, setStatus, incrementStreams, decrementStreams, addNotification, notificationsEnabled, pushEvent]);
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}
