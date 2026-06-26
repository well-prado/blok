import { notificationForRunEvent } from "@/lib/runEvents";
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

	// Use individual selectors — Zustand action functions are stable references
	// that never change between renders. NEVER destructure from useStore() without
	// a selector: that subscribes to ALL state changes and creates new object refs
	// on every render, which causes useEffect infinite loops.
	const setStatus = useConnectionStore((s) => s.setStatus);
	const incrementStreams = useConnectionStore((s) => s.incrementStreams);
	const decrementStreams = useConnectionStore((s) => s.decrementStreams);
	const addNotification = useNotificationStore((s) => s.addNotification);
	const pushEvent = useLiveFeedStore((s) => s.pushEvent);

	// Read notificationsEnabled via ref so toggling it doesn't tear down the SSE connection
	const notificationsEnabledRef = useRef(useNotificationStore.getState().enabled);
	useEffect(() => {
		return useNotificationStore.subscribe((s) => {
			notificationsEnabledRef.current = s.enabled;
		});
	}, []);

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

				// Emit a notification for the terminal run events that warrant one
				// (completed/failed/crashed/timedOut/cancelled — see notificationForRunEvent).
				if (notificationsEnabledRef.current) {
					const toast = notificationForRunEvent(event);
					if (toast) {
						addNotification({ ...toast, runId: event.runId, workflowName: event.workflowName });
					}
				}
			},
			onOpen: () => setStatus("connected"),
			onError: () => setStatus("error"),
		});

		return () => {
			disconnect();
			decrementStreams();
			setStatus("disconnected");
			if (invalidateTimer.current) {
				clearTimeout(invalidateTimer.current);
				invalidateTimer.current = null;
			}
		};
	}, [enabled, queryClient, setStatus, incrementStreams, decrementStreams, addNotification, pushEvent]);
}
