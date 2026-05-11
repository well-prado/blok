/**
 * v0.7 — per-connection API exposed on `ctx.connection` for triggers
 * that hold long-lived bidirectional channels (WebSocket today; SSE
 * gets a streaming variant in PR 3).
 *
 * Authors interact with the connection through this object — the
 * trigger wraps the underlying transport's send/close primitives and
 * tracks per-connection state. Lifecycle:
 *
 *   - On `connect`: trigger creates the connection, runs the workflow
 *     once with `ctx.connection` bound. Author can call
 *     `setAttachment()` to store per-connection state.
 *   - On `message`: trigger runs the workflow again with the same
 *     `ctx.connection` instance — author reads `attachment` to recover
 *     the per-connection state.
 *   - On `disconnect`: same connection, last run. Cleanup happens here.
 *
 * Absent on contexts built for HTTP / Worker / Cron triggers.
 */
export interface ConnectionContext {
	/** Stable connection identifier (uuid). Set once at connect. */
	readonly id: string;

	/**
	 * Send data to THIS connection.
	 * - Text payloads: send a string (typically `JSON.stringify(...)`).
	 * - Binary payloads: send a `Uint8Array` or `ArrayBuffer`.
	 *
	 * Buffered if the underlying socket is busy; backpressure visible
	 * via the trigger's `messageRateLimit` and Studio trace metrics.
	 */
	send(data: string | ArrayBuffer | Uint8Array): void;

	/**
	 * Close THIS connection cleanly. Subsequent `send` calls are no-ops.
	 * Triggers the `disconnect` workflow run as a final step.
	 *
	 * @param code   Close code per RFC 6455 (default 1000 — normal).
	 * @param reason Human-readable reason (max 123 bytes per RFC).
	 */
	close(code?: number, reason?: string): void;

	/**
	 * Store per-connection state. Survives across message-event workflow
	 * runs on the same connection — the "userId + joinedAt + cursor"
	 * pattern. Reset by every call (no merge).
	 *
	 * Inspired by Cloudflare Durable Objects'
	 * `state.serializeAttachment()` API. Capped at 2 KB serialized JSON;
	 * larger values are rejected with a warning log (the connection
	 * stays open).
	 */
	setAttachment(value: unknown): void;

	/**
	 * Retrieve per-connection state set by `setAttachment()`. Returns
	 * `undefined` if nothing was set on this connection.
	 */
	readonly attachment: unknown;

	/**
	 * Channel/room membership for fan-out broadcasts. Multiple
	 * connections can join the same room; `@blokjs/ws-broadcast`
	 * targets every member.
	 */
	joinRoom(name: string): void;
	leaveRoom(name: string): void;
	readonly rooms: ReadonlySet<string>;

	/**
	 * v0.7 — broadcast a message to every connection in the named
	 * room (workflow-scoped). Returns the number of recipients
	 * the trigger successfully sent to.
	 *
	 * Set `exceptSelf: true` to skip the connection that triggered
	 * the current workflow run (the "send to everyone except me"
	 * pattern). Bound by the trigger via this `ctx.connection`
	 * accessor so helper nodes (`@blokjs/ws-broadcast`) don't need
	 * to import the trigger package directly.
	 */
	broadcast(room: string, data: string | ArrayBuffer | Uint8Array, opts?: { exceptSelf?: boolean }): number;
}

export default ConnectionContext;
