import type { RunEvent } from "@/types";

const BASE_URL = "/__blok";

export interface SSEConnectionOptions {
	/** Called for each event received. */
	onEvent: (event: RunEvent) => void;
	/** Called when the stream ends (run finished). */
	onEnd?: () => void;
	/** Called on connection error. */
	onError?: (error: Event) => void;
	/** Called when connection is established. */
	onOpen?: () => void;
	/** Connection timeout in ms. Fires onError and closes if not connected in time. Default: 10000 */
	timeout?: number;
}

/**
 * Open an SSE connection to a specific run's event stream.
 * Returns a cleanup function to close the connection.
 */
export function connectRunStream(runId: string, options: SSEConnectionOptions): () => void {
	const url = `${BASE_URL}/runs/${encodeURIComponent(runId)}/stream`;
	return createSSEConnection(url, options);
}

/**
 * Open an SSE connection to the global event stream.
 * Optionally filter by workflow names.
 * Returns a cleanup function to close the connection.
 */
export function connectGlobalStream(options: SSEConnectionOptions, workflows?: string[]): () => void {
	let url = `${BASE_URL}/stream`;
	if (workflows?.length) {
		url += `?workflows=${workflows.map(encodeURIComponent).join(",")}`;
	}
	return createSSEConnection(url, options);
}

// Must mirror the RunEventType union in core/runner/src/tracing/types.ts — the
// browser EventSource only delivers events whose `event:` name has a registered
// listener, so any type missing here is silently dropped by the client. The
// terminal run events (crashed/timedOut/throttled/cancelled/expired) and the
// Tier-1/2 node events (cached/attempt-failed/progress) were absent, so Studio
// never saw a run that ended in any state other than completed/failed.
const EVENT_TYPES = [
	"RUN_STARTED",
	"RUN_COMPLETED",
	"RUN_FAILED",
	"RUN_THROTTLED",
	"RUN_DELAYED",
	"RUN_EXPIRED",
	"RUN_DEBOUNCED",
	"RUN_QUEUED",
	"RUN_CANCELLED",
	"RUN_CRASHED",
	"RUN_TIMED_OUT",
	"NODE_STARTED",
	"NODE_COMPLETED",
	"NODE_FAILED",
	"NODE_SKIPPED",
	"NODE_CACHED",
	"NODE_ATTEMPT_FAILED",
	"NODE_PROGRESS",
	"NODE_PARTIAL_RESULT",
	"VARS_UPDATED",
	"LOG_ENTRY",
] as const;

const MAX_RETRIES = 10;
const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

function createSSEConnection(url: string, options: SSEConnectionOptions): () => void {
	let source: EventSource | null = null;
	let opened = false;
	let retryCount = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let connectTimeout: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	const timeoutMs = options.timeout ?? 10000;

	function connect() {
		if (closed) return;

		source = new EventSource(url);
		opened = false;

		// Connection timeout — close and fire error if not connected in time
		connectTimeout = setTimeout(() => {
			if (!opened && !closed) {
				source?.close();
				options.onError?.(new Event("timeout"));
				scheduleRetry();
			}
		}, timeoutMs);

		const markOpen = () => {
			if (opened) return;
			opened = true;
			retryCount = 0;
			if (connectTimeout) {
				clearTimeout(connectTimeout);
				connectTimeout = null;
			}
			options.onOpen?.();
		};

		// Browser fires onopen on first data chunk (fallback)
		source.onopen = markOpen;

		// Explicit backend acknowledgment (preferred — fires immediately)
		source.addEventListener("connected", markOpen);

		source.onerror = () => {
			if (closed) return;
			source?.close();
			if (connectTimeout) {
				clearTimeout(connectTimeout);
				connectTimeout = null;
			}
			options.onError?.(new Event("error"));
			scheduleRetry();
		};

		// Event listeners
		const handler = (e: MessageEvent) => {
			try {
				const event = JSON.parse(e.data) as RunEvent;
				options.onEvent(event);
			} catch {
				// ignore parse errors
			}
		};

		for (const type of EVENT_TYPES) {
			source.addEventListener(type, handler);
		}

		// Stream-end (run finished)
		source.addEventListener("stream-end", () => {
			options.onEnd?.();
			cleanup();
		});
	}

	function scheduleRetry() {
		if (closed || retryCount >= MAX_RETRIES) return;
		const delay = Math.min(BASE_DELAY * 2 ** retryCount, MAX_DELAY);
		retryCount++;
		retryTimer = setTimeout(connect, delay);
	}

	function cleanup() {
		closed = true;
		source?.close();
		source = null;
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		if (connectTimeout) {
			clearTimeout(connectTimeout);
			connectTimeout = null;
		}
	}

	connect();
	return cleanup;
}
