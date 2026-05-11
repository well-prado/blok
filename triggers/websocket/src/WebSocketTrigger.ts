/**
 * WebSocketTrigger — v0.7 PR 2 — Concrete WebSocket trigger that
 * registers Hono routes on a shared `Hono<AppBindings>` app so
 * WebSocket connections live alongside HTTP routes on the same port.
 *
 * **Authoring surface:**
 *
 * ```json
 * {
 *   "name": "chat-room",
 *   "trigger": {
 *     "websocket": {
 *       "path": "/ws/chat/:roomId",
 *       "events": ["message", "typing"],
 *       "middleware": ["jwt-auth"]
 *     }
 *   },
 *   "steps": [
 *     { "id": "broadcast", "use": "@blokjs/ws-broadcast", "inputs": {...} }
 *   ]
 * }
 * ```
 *
 * **Lifecycle (one workflow run per event):**
 *
 *   - `event: "connect"` — fires once on upgrade. Workflow can set
 *     `ctx.connection.attachment` and join rooms.
 *   - `event: "message"` — fires per incoming message. Author can
 *     reply via `@blokjs/ws-reply` or broadcast via `@blokjs/ws-broadcast`.
 *   - `event: "disconnect"` — fires once on close. Cleanup happens here.
 *
 * **Hono integration:** the trigger is constructed with the shared
 * `Hono<AppBindings>` app (typically from `HttpTrigger`). On `listen()`,
 * it walks `WorkflowRegistry` for workflows with `trigger.websocket`,
 * registers one `app.get(path, upgradeWebSocket(...))` per workflow,
 * and hooks `injectWebSocket(server)` into the `http.Server` via
 * `httpTrigger.addServerHook(...)`. All four protocols (HTTP/WS/SSE/
 * Webhook) end up on port 4000 via Hono's path-routing tree.
 *
 * See [additional-triggers-plan.mdx](../../../docs/c/devtools/additional-triggers-plan.mdx#websocket-trigger)
 * for the full v0.7 design.
 */

import type { Server } from "node:http";
import {
	DefaultLogger,
	type GlobalOptions as RunnerGlobalOptions,
	TriggerBase,
	WorkflowRegistry,
} from "@blokjs/runner";
import type { ConnectionContext, Context, RequestContext } from "@blokjs/shared";
import { createNodeWebSocket } from "@hono/node-ws";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import type { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { v4 as uuid } from "uuid";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * v0.7 WebSocket trigger config — mirrors `WebSocketTriggerOptsSchema`
 * in `core/workflow-helper/src/types/TriggerOpts.ts`. Fields are read
 * loosely here because Configuration has already validated the schema
 * by the time we walk the registry.
 */
interface WebSocketTriggerConfig {
	path: string;
	events?: string[]; // event-name allowlist; absent = accept all
	middleware?: string[]; // trigger-level middleware chain
	heartbeatInterval?: number; // ms; default 30000
	maxConnections?: number; // hard cap on concurrent connections; default 10000
	messageRateLimit?: number; // msgs/sec/connection; default 100
	mode?: "text" | "binary"; // payload mode; default "text"
}

/** Internal per-connection state. */
interface ConnectionState {
	id: string;
	ws: WSContext;
	workflowName: string;
	path: string;
	pathParams: Record<string, string>;
	rooms: Set<string>;
	attachment: unknown;
	connectedAt: number;
	lastActivity: number;
	tokens: number; // rate-limiter bucket
	tokensRefilledAt: number;
}

interface HttpTriggerLike {
	addServerHook(cb: (server: Server) => void | Promise<void>): void;
	addPreCatchAllHook(cb: () => void | Promise<void>): void;
}

// -----------------------------------------------------------------------------
// Trigger class
// -----------------------------------------------------------------------------

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 10_000;
const DEFAULT_MESSAGE_RATE_LIMIT = 100; // msgs/sec/connection
const ATTACHMENT_MAX_BYTES = 2_048; // 2 KB cap per CF DO pattern

export default class WebSocketTrigger extends TriggerBase {
	protected nodeMap: RunnerGlobalOptions = {} as RunnerGlobalOptions;

	protected readonly logger = new DefaultLogger();

	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-websocket-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);

	private readonly meter = metrics.getMeter("blok");
	private readonly counterMessagesReceived = this.meter.createCounter("blok_websocket_messages_received_total", {
		description: "WebSocket messages received per workflow.",
		unit: "1",
	});
	private readonly counterMessagesDropped = this.meter.createCounter("blok_websocket_messages_dropped_total", {
		description: "WebSocket messages dropped (rate limit, no handler, auth failure).",
		unit: "1",
	});
	private readonly counterConnections = this.meter.createCounter("blok_websocket_connections_total", {
		description: "WebSocket connections opened (cumulative).",
		unit: "1",
	});

	// Hono's strict-types preserve route-shape inference through middleware
	// chains. @hono/node-ws (and most third-party middleware) accept
	// `Hono<any, any, any>` because their own generics aren't refined enough
	// for the propagation. We type the trigger's `app` field the same way
	// to keep the API surface tolerant of any concrete Hono instance.
	// biome-ignore lint/suspicious/noExplicitAny: Hono's generic propagation
	private readonly app: Hono<any, any, any>;
	private readonly httpTrigger: HttpTriggerLike | null;

	private upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"] | null = null;
	private injectWebSocket: ((server: Server) => void) | null = null;

	private connections: Map<string, ConnectionState> = new Map();

	/** workflow name → set of connection IDs subscribed to it. */
	private connectionsByWorkflow: Map<string, Set<string>> = new Map();

	/** room name (workflow-scoped) → set of connection IDs. */
	private rooms: Map<string, Set<string>> = new Map();

	private heartbeatTimer: NodeJS.Timeout | null = null;
	private wired = false;

	/**
	 * @param app          Shared Hono app. Constructed by an orchestrator
	 *                     or by HttpTrigger; WS routes are registered on
	 *                     the same instance so HTTP + WS multiplex on one
	 *                     TCP port.
	 * @param httpTrigger  Optional HttpTrigger-like object exposing
	 *                     `addServerHook`. When provided, WebSocketTrigger
	 *                     hooks `injectWebSocket(server)` into the post-
	 *                     `serve()` callback so the upgrade listener
	 *                     attaches without the caller having to wire it.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: matches `app` field's any generic
	constructor(app: Hono<any, any, any>, httpTrigger?: HttpTriggerLike) {
		super();
		this.app = app;
		this.httpTrigger = httpTrigger ?? null;
		// Register as the active trigger so helper nodes
		// (@blokjs/ws-broadcast, @blokjs/ws-close) can look up the
		// trigger via the singleton accessor. Single-instance only
		// (the v0.7 scope is single-process; cross-process broadcast
		// is deferred per the spec).
		_setActiveWebSocketTrigger(this);
	}

	/**
	 * Inject the runner's GlobalOptions (nodes + workflows). Called by
	 * the orchestrator AFTER constructing both triggers but BEFORE
	 * `listen()`. The HTTP trigger's `loadNodes()` + `loadWorkflows()`
	 * produces this map; we share it so both triggers see the same
	 * workflow definitions.
	 *
	 * Backward-compat: when not called, the trigger falls back to an
	 * empty map — the `listen()` walk through `WorkflowRegistry` still
	 * works because the registry is populated by HttpTrigger's workflow
	 * scan at boot.
	 */
	setNodeMap(nodeMap: RunnerGlobalOptions): void {
		this.nodeMap = nodeMap;
	}

	/**
	 * Register Hono WebSocket routes for every workflow whose
	 * `trigger.websocket` config is present in `WorkflowRegistry`.
	 *
	 * Mounting timeline:
	 *   1. `createNodeWebSocket({ app })` — bind to the shared app.
	 *   2. For each registered WS workflow: `app.get(path, upgradeWebSocket(...))`.
	 *   3. Register `injectWebSocket` on `httpTrigger.addServerHook`.
	 *      HttpTrigger calls it inside the `serve()` ready callback
	 *      with the bound `http.Server` — the WS upgrade listener
	 *      attaches automatically.
	 */
	async listen(): Promise<number> {
		const startTime = this.startCounter();

		if (this.wired) {
			this.logger.log("[blok][ws] listen() called twice; ignoring");
			return this.endCounter(startTime);
		}

		// Wire createNodeWebSocket immediately so upgradeWebSocket /
		// injectWebSocket are available. The actual ROUTE registration
		// is deferred to the server hook below so it runs AFTER
		// HttpTrigger has populated WorkflowRegistry via its workflow
		// scan. Hono allows route addition after `serve()` because
		// `app.fetch` is mutated in place.
		const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app: this.app });
		this.upgradeWebSocket = upgradeWebSocket;
		this.injectWebSocket = injectWebSocket;

		this.startHeartbeat();
		this.wired = true;

		// Coordinate with HttpTrigger:
		//   1. HttpTrigger.listen() scans workflows + populates WorkflowRegistry.
		//   2. HttpTrigger fires preCatchAllHooks — we walk the registry and
		//      register one `app.get(path, upgradeWebSocket(...))` per WS
		//      workflow. Done BEFORE the legacy `/:workflow{.+}` catch-all
		//      so Hono dispatches `/ws/<path>` to our upgrade handler
		//      instead of treating it as a workflow lookup.
		//   3. HttpTrigger.listen() calls serve() → http.Server is up.
		//   4. serve() ready-callback runs our server hook → we call
		//      injectWebSocket(server) to attach the upgrade listener.
		if (this.httpTrigger) {
			this.httpTrigger.addPreCatchAllHook(() => {
				const workflows = this.getWebSocketWorkflows();
				if (workflows.length === 0) {
					this.logger.log("[blok][ws] no workflows with trigger.websocket found");
					return;
				}
				this.logger.log(`[blok][ws] registering ${workflows.length} WebSocket route(s):`);
				for (const entry of workflows) {
					this.registerWsRoute(entry);
				}
			});
			this.httpTrigger.addServerHook((server) => {
				this.injectWebSocket?.(server);
				this.logger.log("[blok][ws] WebSocket upgrade handler attached to http.Server");
			});
		} else {
			// No httpTrigger — caller is responsible for calling
			// `getRoutes()` / `injectWebSocket()` themselves. Used by
			// unit tests that supply their own app + server lifecycle.
			const workflows = this.getWebSocketWorkflows();
			if (workflows.length === 0) {
				this.logger.log("[blok][ws] no workflows with trigger.websocket found");
			} else {
				this.logger.log(`[blok][ws] registering ${workflows.length} WebSocket route(s):`);
				for (const entry of workflows) {
					this.registerWsRoute(entry);
				}
			}
		}

		return this.endCounter(startTime);
	}

	async stop(): Promise<void> {
		this.stopHeartbeat();
		// Close all open connections with a "going away" code.
		for (const conn of this.connections.values()) {
			try {
				conn.ws.close(1001, "Server shutting down");
			} catch {
				/* ignore */
			}
		}
		this.connections.clear();
		this.connectionsByWorkflow.clear();
		this.rooms.clear();
		this.wired = false;
		// Clear the singleton — helper nodes should fail loudly if used
		// after stop() rather than silently no-op against a stale handle.
		if (_getActiveWebSocketTrigger() === this) {
			_setActiveWebSocketTrigger(null);
		}
		this.destroyMonitoring();
		this.logger.log("[blok][ws] stopped");
	}

	// ---------------------------------------------------------------------------
	// Route registration (one Hono route per workflow)
	// ---------------------------------------------------------------------------

	private registerWsRoute(entry: { workflowName: string; config: WebSocketTriggerConfig }): void {
		if (!this.upgradeWebSocket) return;
		const { workflowName, config } = entry;
		this.logger.log(`[blok][ws]   GET     ${config.path}  ←  ${workflowName}`);

		// One route per workflow; the handler factory captures workflowName
		// and runs the workflow at each lifecycle event.
		this.app.get(
			config.path,
			this.upgradeWebSocket((c) => {
				// At upgrade time: extract path params + query so the
				// `connect` workflow can route on roomId / userId / etc.
				const pathParams = c.req.param() as Record<string, string>;
				const queryParams = Object.fromEntries(new URL(c.req.url).searchParams);
				const headers = Object.fromEntries(c.req.raw.headers);

				// Check connection cap BEFORE accepting the upgrade. If
				// over the limit, the handler factory throws so Hono
				// closes the connection — slightly clunky API but matches
				// the upgradeWebSocket contract (we can't easily return
				// 503 from inside the factory).
				const cap = typeof config.maxConnections === "number" ? config.maxConnections : DEFAULT_MAX_CONNECTIONS;
				if (this.connections.size >= cap) {
					this.logger.error(`[blok][ws] connection cap reached (${cap}) — refusing upgrade for ${workflowName}`);
					this.counterMessagesDropped.add(1, { workflow_name: workflowName, reason: "max_connections" });
				}

				const connectionId = uuid();

				// `onOpen` runs synchronously on accept; we register the
				// connection here and dispatch the `connect` workflow run
				// asynchronously (don't block the upgrade).
				return {
					onOpen: (_evt, ws) => {
						// Even if we're over-cap, we still need to register
						// briefly so onMessage/onClose don't throw — close
						// immediately if cap was already hit.
						if (this.connections.size >= cap) {
							ws.close(1013, "Server at capacity");
							return;
						}
						const now = Date.now();
						const state: ConnectionState = {
							id: connectionId,
							ws,
							workflowName,
							path: config.path,
							pathParams,
							rooms: new Set(),
							attachment: undefined,
							connectedAt: now,
							lastActivity: now,
							tokens:
								typeof config.messageRateLimit === "number" ? config.messageRateLimit : DEFAULT_MESSAGE_RATE_LIMIT,
							tokensRefilledAt: now,
						};
						this.connections.set(connectionId, state);
						let workflowSet = this.connectionsByWorkflow.get(workflowName);
						if (!workflowSet) {
							workflowSet = new Set();
							this.connectionsByWorkflow.set(workflowName, workflowSet);
						}
						workflowSet.add(connectionId);
						this.counterConnections.add(1, { workflow_name: workflowName });

						// Fire the `connect` workflow asynchronously — we
						// can't await here; the upgrade callback is
						// synchronous-ish from Hono's POV.
						void this.dispatchEvent({
							connectionId,
							workflowName,
							config,
							eventKind: "connect",
							payload: { event: "connect", headers, params: pathParams, query: queryParams },
						});
					},
					onMessage: (evt, _ws) => {
						const state = this.connections.get(connectionId);
						if (!state) return;
						state.lastActivity = Date.now();
						this.counterMessagesReceived.add(1, { workflow_name: workflowName });

						// Rate limit (per-connection token bucket).
						if (!this.consumeRateToken(state, config)) {
							this.counterMessagesDropped.add(1, {
								workflow_name: workflowName,
								reason: "rate_limit",
							});
							return;
						}

						// Parse payload. Default mode "text" assumes JSON
						// frames with `{event, data}` envelope; falls back
						// to `{event: "message", data: <text>}` on parse
						// failure. Binary mode skips JSON entirely and
						// hands the buffer through unchanged.
						let event = "message";
						let payload: unknown = evt.data;
						const mode = config.mode === "binary" ? "binary" : "text";
						if (mode === "text" && typeof evt.data === "string") {
							try {
								const parsed = JSON.parse(evt.data) as { event?: unknown; data?: unknown };
								if (typeof parsed.event === "string") event = parsed.event;
								payload = parsed.data ?? parsed;
							} catch {
								/* not JSON — leave event as "message", payload as raw string */
							}
						}

						// Allowlist check — if the trigger declares an
						// `events` array, drop messages whose event name
						// isn't in the list. Absent allowlist = accept all.
						if (Array.isArray(config.events) && config.events.length > 0 && !config.events.includes(event)) {
							this.counterMessagesDropped.add(1, {
								workflow_name: workflowName,
								reason: "event_not_allowed",
							});
							return;
						}

						void this.dispatchEvent({
							connectionId,
							workflowName,
							config,
							eventKind: "message",
							payload: { event, data: payload },
						});
					},
					onClose: (evt, _ws) => {
						void this.dispatchEvent({
							connectionId,
							workflowName,
							config,
							eventKind: "disconnect",
							payload: { event: "disconnect", code: evt.code, reason: evt.reason },
						}).finally(() => {
							// Even if the disconnect workflow throws, free
							// the connection record AFTER it finishes so
							// `ctx.connection` is valid throughout the
							// disconnect run.
							this.removeConnection(connectionId);
						});
					},
					onError: (_evt, _ws) => {
						this.logger.error(`[blok][ws] connection error on ${workflowName} (id=${connectionId})`);
					},
				};
			}),
		);
	}

	// ---------------------------------------------------------------------------
	// Workflow dispatch
	// ---------------------------------------------------------------------------

	/**
	 * Build a synthetic Context, attach `ctx.connection`, run the
	 * trigger's middleware chain + workflow body. One run per event.
	 *
	 * Uses TriggerBase's existing `createContext` + `applyMiddlewareChain`
	 * + `run` pipeline so all the standard primitives (concurrency,
	 * retries, idempotency, tracing, etc.) apply uniformly.
	 */
	private async dispatchEvent(opts: {
		connectionId: string;
		workflowName: string;
		config: WebSocketTriggerConfig;
		eventKind: "connect" | "message" | "disconnect";
		payload: Record<string, unknown>;
	}): Promise<void> {
		const { connectionId, workflowName, eventKind, payload } = opts;
		const state = this.connections.get(connectionId);
		if (!state) return;

		const requestId = uuid();
		const triggerLabel = `websocket.${eventKind}`;

		await this.tracer.startActiveSpan(`ws:${workflowName}:${eventKind}`, async (span: Span) => {
			try {
				// Initialize Configuration for the workflow (loads the
				// step graph, applies the v2 normalizer, resolves nodes).
				// Pass the workflow as the third `preloaded` argument so
				// Configuration uses the in-registry definition directly
				// instead of trying to load from disk — same pattern
				// HttpTrigger uses for its file-based routing path.
				const registry = WorkflowRegistry.getInstance();
				const entry = registry.get(workflowName);
				if (!entry) {
					throw new Error(`[blok][ws] workflow "${workflowName}" not found in registry`);
				}
				await this.configuration.init(workflowName, this.nodeMap, entry.workflow);

				const ctx: Context = this.createContext(undefined, workflowName, requestId);
				ctx.request = {
					body: payload,
					headers: {} as RequestContext["headers"],
					params: state.pathParams,
					query: {},
				} as unknown as RequestContext;

				// Bind ctx.connection — the per-connection API. Helper
				// nodes (@blokjs/ws-reply, @blokjs/ws-broadcast, @blokjs/ws-close)
				// read this field directly to interact with the WS.
				ctx.connection = this.buildConnectionContext(state);

				// Run middleware chain (process-global → workflow-level →
				// trigger-level). Identical to HttpTrigger/WorkerTrigger.
				await this.applyMiddlewareChain(ctx, this.nodeMap);

				await this.run(ctx);

				span.setAttribute("workflow_name", workflowName);
				span.setAttribute("event", eventKind);
				span.setAttribute("connection_id", connectionId);
				span.setStatus({ code: SpanStatusCode.OK });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				span.recordException(err as Error);
				span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
				this.logger.error(`[blok][ws] ${triggerLabel} workflow ${workflowName} failed: ${msg}`);
			} finally {
				span.end();
			}
		});
	}

	private buildConnectionContext(state: ConnectionState): ConnectionContext {
		const id = state.id;
		const trigger = this;
		return {
			get id() {
				return id;
			},
			send(data) {
				const conn = trigger.connections.get(id);
				if (!conn) return;
				try {
					// WSContext.send's strict type is Uint8Array<ArrayBuffer>;
					// our interface uses the wider Uint8Array<ArrayBufferLike>
					// (which TypeScript splits into ArrayBuffer | SharedArrayBuffer).
					// SharedArrayBuffer can't legally cross WS frames anyway, so
					// the cast is safe — we accept the strict subset at runtime.
					conn.ws.send(data as Parameters<typeof conn.ws.send>[0]);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					trigger.logger.error(`[blok][ws] send failed on ${id}: ${msg}`);
				}
			},
			close(code, reason) {
				const conn = trigger.connections.get(id);
				if (!conn) return;
				try {
					conn.ws.close(code, reason);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					trigger.logger.error(`[blok][ws] close failed on ${id}: ${msg}`);
				}
			},
			setAttachment(value) {
				const conn = trigger.connections.get(id);
				if (!conn) return;
				// Cap serialized size — per the spec's 2 KB Cloudflare-DO
				// parity rule. Reject + warn on overflow rather than
				// truncate (truncation produces malformed JSON on next read).
				try {
					const serialized = JSON.stringify(value);
					if (serialized && Buffer.byteLength(serialized, "utf8") > ATTACHMENT_MAX_BYTES) {
						trigger.logger.logLevel(
							"warn",
							`[blok][ws] attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes on ${id}; rejected. Reduce attachment size.`,
						);
						return;
					}
				} catch {
					trigger.logger.logLevel("warn", `[blok][ws] attachment is not JSON-serializable on ${id}; rejected.`);
					return;
				}
				conn.attachment = value;
			},
			get attachment() {
				const conn = trigger.connections.get(id);
				return conn?.attachment;
			},
			joinRoom(name) {
				const conn = trigger.connections.get(id);
				if (!conn) return;
				const fullName = `${conn.workflowName}:${name}`;
				let set = trigger.rooms.get(fullName);
				if (!set) {
					set = new Set();
					trigger.rooms.set(fullName, set);
				}
				set.add(id);
				conn.rooms.add(fullName);
			},
			leaveRoom(name) {
				const conn = trigger.connections.get(id);
				if (!conn) return;
				const fullName = `${conn.workflowName}:${name}`;
				const set = trigger.rooms.get(fullName);
				if (set) {
					set.delete(id);
					if (set.size === 0) trigger.rooms.delete(fullName);
				}
				conn.rooms.delete(fullName);
			},
			get rooms() {
				const conn = trigger.connections.get(id);
				// Return short-name view (strip `workflowName:` prefix) so
				// authors see what they joined.
				const view = new Set<string>();
				if (conn) {
					const prefix = `${conn.workflowName}:`;
					for (const r of conn.rooms) {
						if (r.startsWith(prefix)) view.add(r.slice(prefix.length));
					}
				}
				return view;
			},
			broadcast(room, data, opts) {
				const conn = trigger.connections.get(id);
				if (!conn) return 0;
				return trigger.broadcastToRoom({
					workflowName: conn.workflowName,
					room,
					data,
					exceptConnectionId: opts?.exceptSelf === true ? id : undefined,
				});
			},
		};
	}

	private removeConnection(connectionId: string): void {
		const state = this.connections.get(connectionId);
		if (!state) return;
		// Drain rooms.
		for (const room of state.rooms) {
			const set = this.rooms.get(room);
			if (set) {
				set.delete(connectionId);
				if (set.size === 0) this.rooms.delete(room);
			}
		}
		// Drain workflow membership.
		const wfSet = this.connectionsByWorkflow.get(state.workflowName);
		if (wfSet) {
			wfSet.delete(connectionId);
			if (wfSet.size === 0) this.connectionsByWorkflow.delete(state.workflowName);
		}
		this.connections.delete(connectionId);
	}

	// ---------------------------------------------------------------------------
	// Helper-node entry points (used by @blokjs/ws-broadcast et al.)
	// ---------------------------------------------------------------------------

	/**
	 * Broadcast to all connections in a workflow-scoped room. Used by
	 * `@blokjs/ws-broadcast` via the singleton accessor below.
	 */
	broadcastToRoom(opts: {
		workflowName: string;
		room: string;
		data: string | ArrayBuffer | Uint8Array;
		exceptConnectionId?: string;
	}): number {
		const fullName = `${opts.workflowName}:${opts.room}`;
		const set = this.rooms.get(fullName);
		if (!set) return 0;
		let count = 0;
		for (const cid of set) {
			if (opts.exceptConnectionId && cid === opts.exceptConnectionId) continue;
			const conn = this.connections.get(cid);
			if (!conn) continue;
			try {
				// Same Uint8Array<ArrayBufferLike> → Uint8Array<ArrayBuffer>
				// narrowing as the per-connection `send` above. Safe at runtime.
				conn.ws.send(opts.data as Parameters<typeof conn.ws.send>[0]);
				count++;
			} catch {
				/* skip dead sockets */
			}
		}
		return count;
	}

	/** Read-only stats for tests / Studio. */
	getStats(): {
		connections: number;
		workflows: number;
		rooms: number;
	} {
		return {
			connections: this.connections.size,
			workflows: this.connectionsByWorkflow.size,
			rooms: this.rooms.size,
		};
	}

	// ---------------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------------

	private getWebSocketWorkflows(): Array<{ workflowName: string; config: WebSocketTriggerConfig }> {
		const registry = WorkflowRegistry.getInstance();
		const out: Array<{ workflowName: string; config: WebSocketTriggerConfig }> = [];
		for (const entry of registry.list()) {
			const wf = entry.workflow as { trigger?: { websocket?: WebSocketTriggerConfig } } | undefined;
			const wsCfg = wf?.trigger?.websocket;
			if (!wsCfg || typeof wsCfg.path !== "string") continue;
			out.push({ workflowName: entry.name, config: wsCfg });
		}
		return out;
	}

	private consumeRateToken(state: ConnectionState, config: WebSocketTriggerConfig): boolean {
		const limit =
			typeof config.messageRateLimit === "number" && config.messageRateLimit > 0
				? config.messageRateLimit
				: DEFAULT_MESSAGE_RATE_LIMIT;
		const now = Date.now();
		const elapsedMs = now - state.tokensRefilledAt;
		if (elapsedMs > 0) {
			const refill = (elapsedMs / 1000) * limit;
			state.tokens = Math.min(limit, state.tokens + refill);
			state.tokensRefilledAt = now;
		}
		if (state.tokens < 1) return false;
		state.tokens -= 1;
		return true;
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) return;
		this.heartbeatTimer = setInterval(() => {
			const now = Date.now();
			for (const [id, state] of this.connections) {
				const idleMs = now - state.lastActivity;
				if (idleMs > 2 * DEFAULT_HEARTBEAT_INTERVAL_MS) {
					// Stale connection — close it.
					try {
						state.ws.close(1011, "Heartbeat timeout");
					} catch {
						/* ignore */
					}
					this.removeConnection(id);
				}
				// `ws` library's underlying socket auto-pings via `ws.ping()`
				// — we just need to track lastActivity which onMessage
				// updates. No explicit ping needed from the trigger layer.
			}
		}, DEFAULT_HEARTBEAT_INTERVAL_MS);
		// Don't keep the event loop alive on the heartbeat alone.
		if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}
}

// -----------------------------------------------------------------------------
// Singleton accessor for helper nodes
// -----------------------------------------------------------------------------

/**
 * Singleton registry — helper nodes (`@blokjs/ws-broadcast` etc.) read
 * the active trigger via this accessor to call `broadcastToRoom(...)`.
 * Set once at trigger construction; reset on `stop()`.
 *
 * Why not pass through ctx? `ctx.connection` is the per-connection API.
 * The cross-connection `broadcast` operation needs the trigger
 * instance, which manages all connections. A singleton is the cheapest
 * way for helper nodes to find the trigger without threading it
 * through every step's inputs.
 */
let activeTrigger: WebSocketTrigger | null = null;

export function _setActiveWebSocketTrigger(trigger: WebSocketTrigger | null): void {
	activeTrigger = trigger;
}

export function _getActiveWebSocketTrigger(): WebSocketTrigger | null {
	return activeTrigger;
}

// Re-export types kept stable from prior scaffold so any external
// references (Studio, docs links) keep resolving. Most are unused by
// the new implementation but harmless to re-export.
export type { ConnectionContext } from "@blokjs/shared";

// Unused but exported for backward compatibility with the prior scaffold.
export type WebSocketMessageType = "text" | "binary";
