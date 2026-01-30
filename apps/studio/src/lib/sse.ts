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
export function connectGlobalStream(
  options: SSEConnectionOptions,
  workflows?: string[],
): () => void {
  let url = `${BASE_URL}/stream`;
  if (workflows?.length) {
    url += `?workflows=${workflows.map(encodeURIComponent).join(",")}`;
  }
  return createSSEConnection(url, options);
}

function createSSEConnection(url: string, options: SSEConnectionOptions): () => void {
  const source = new EventSource(url);

  source.onopen = () => {
    options.onOpen?.();
  };

  source.onerror = (e) => {
    options.onError?.(e);
  };

  // Listen to all known event types
  const eventTypes = [
    "RUN_STARTED",
    "RUN_COMPLETED",
    "RUN_FAILED",
    "NODE_STARTED",
    "NODE_COMPLETED",
    "NODE_FAILED",
    "NODE_SKIPPED",
    "VARS_UPDATED",
    "LOG_ENTRY",
  ];

  const handler = (e: MessageEvent) => {
    try {
      const event = JSON.parse(e.data) as RunEvent;
      options.onEvent(event);
    } catch {
      // ignore parse errors
    }
  };

  for (const type of eventTypes) {
    source.addEventListener(type, handler);
  }

  // Listen for stream-end
  source.addEventListener("stream-end", () => {
    options.onEnd?.();
    source.close();
  });

  return () => {
    source.close();
  };
}
