/**
 * v0.7 — per-stream API exposed on `ctx.stream` for triggers that hold
 * a long-lived, server-push HTTP channel (SSE today; the `streaming`
 * Hono helper underneath). Authors emit events through this object;
 * the trigger owns the underlying `c.writeSSE` / drain handling.
 *
 * Lifecycle (Pattern A — one workflow run per stream open):
 *
 *   - The SSE trigger opens the HTTP stream via Hono's `streamSSE`,
 *     creates this object, attaches it to `ctx.stream`, and dispatches
 *     the workflow once.
 *   - The workflow body writes zero or more events via
 *     `writeSSE(...)`, typically via `@blokjs/sse-stream` consuming an
 *     async iterator from `@blokjs/sse-subscribe`.
 *   - The workflow returns when its iterator ends OR when
 *     `ctx.stream.signal.aborted` flips (client closed). The trigger
 *     ends the run with status `completed`.
 *
 * Absent on contexts built for HTTP (request/response), Worker, Cron,
 * or WebSocket triggers.
 */
export interface StreamContext {
	/** Stable stream/connection identifier (uuid). Set once at open. */
	readonly id: string;

	/**
	 * Write one SSE-framed event to the client. Each call produces a
	 * `data:` (and optional `event:`, `id:`, `retry:`) frame followed
	 * by a blank line.
	 *
	 * `data` is JSON-stringified when it's not a string. Pass a string
	 * to write the payload verbatim. Returns once the chunk has been
	 * accepted by Node's stream (honors backpressure via `drain`).
	 */
	writeSSE(opts: {
		event?: string;
		data: unknown;
		id?: string;
		retry?: number;
	}): Promise<void>;

	/**
	 * Write an SSE comment line (`: <text>\n\n`). Used internally for
	 * heartbeats; authors rarely need this directly. Comments are
	 * ignored by `EventSource` clients but keep proxies from idling
	 * the connection.
	 */
	writeComment(text: string): Promise<void>;

	/**
	 * Close the stream cleanly. Subsequent `writeSSE` calls are no-ops.
	 * The workflow run ends at the next yield point.
	 */
	close(): void;

	/** True after `close()` is called or the client disconnects. */
	readonly closed: boolean;

	/**
	 * `AbortSignal` that fires when the client disconnects (browser tab
	 * closed, network drop, manual `EventSource.close()`). Long-running
	 * iterators / fetches should be bound to this signal so they unwind
	 * promptly:
	 *
	 *     for await (const evt of source) {
	 *       if (ctx.stream.signal.aborted) break;
	 *       await ctx.stream.writeSSE({ data: evt });
	 *     }
	 */
	readonly signal: AbortSignal;

	/**
	 * `Last-Event-Id` HTTP header value from the inbound request, if
	 * the client is reconnecting. Helper nodes (`@blokjs/sse-subscribe`)
	 * read this to resume from the indicated cursor.
	 */
	readonly lastEventId: string | null;

	/**
	 * v0.7 — subscribe to the in-process SSE event bus. Returns an
	 * async iterator that yields events published to any of the named
	 * channels. When `lastEventId` is provided (or omitted — defaults
	 * to `ctx.stream.lastEventId`), buffered events with `seq > lastEventId`
	 * are replayed before live events begin. Caller stops the
	 * subscription by exiting the for-await loop or calling
	 * `iterator.return()`.
	 *
	 * Bound by the trigger so helper nodes (`@blokjs/sse-subscribe`,
	 * `@blokjs/sse-stream`) don't have to import the trigger directly.
	 */
	subscribe(
		channels: string[],
		lastEventId?: string | null,
	): AsyncIterableIterator<{
		channel: string;
		id: string;
		event?: string;
		data: unknown;
		timestamp: number;
	}>;
}

export default StreamContext;
