/**
 * SSETrigger — v0.7 PR 3 — Server-Sent Events trigger that mounts on
 * the shared Hono app via `streamSSE` from `hono/streaming`. Pattern A
 * (per the plan's Q3 resolution): one workflow run per stream open.
 * The workflow body holds the stream as long as the connection is
 * alive, emitting events through `ctx.stream.writeSSE(...)` (typically
 * via `@blokjs/sse-stream`).
 *
 * **Authoring surface:**
 *
 * ```json
 * {
 *   "name": "live-order-updates",
 *   "trigger": {
 *     "sse": {
 *       "path": "/sse/orders/:orderId",
 *       "heartbeatInterval": 15000,
 *       "retryInterval": 3000,
 *       "channels": ["order:{orderId}"]
 *     }
 *   },
 *   "steps": [
 *     { "id": "sub",    "use": "@blokjs/sse-subscribe", "inputs": { "channels": ["order:{orderId}"] } },
 *     { "id": "stream", "use": "@blokjs/sse-stream",    "inputs": { "source": "$.state.sub" } }
 *   ]
 * }
 * ```
 *
 * **Lifecycle:**
 *
 *   1. GET request on `path` triggers `streamSSE`. The trigger opens
 *      the response, binds `ctx.stream`, runs the workflow once.
 *   2. The workflow yields events (usually by pumping an async iterator
 *      from `@blokjs/sse-subscribe`) until it returns OR the client
 *      disconnects (`ctx.stream.signal.aborted` flips).
 *   3. Trigger flushes the close frame, marks the run completed,
 *      releases per-stream state.
 *
 * **Hono integration:** identical to the WebSocket trigger — accepts
 * the shared `Hono<any, any, any>` app and an optional `HttpTriggerLike`
 * exposing `addPreCatchAllHook` so SSE routes are registered AFTER the
 * workflow registry is populated but BEFORE the legacy
 * `/:workflow{.+}` catch-all. Same first-match-wins fix as WS.
 *
 * See [additional-triggers-plan.mdx](../../../docs/c/devtools/additional-triggers-plan.mdx#sse-trigger)
 * for the full design.
 */

import {
	DefaultLogger,
	type GlobalOptions as RunnerGlobalOptions,
	TriggerBase,
	WorkflowRegistry,
} from "@blokjs/runner";
import type { Context, RequestContext, StreamContext } from "@blokjs/shared";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import type { Hono } from "hono";
import type { Context as HonoContext } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { v4 as uuid } from "uuid";
import { getBus } from "./bus";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * v0.7 SSE trigger config — mirrors `SSETriggerOptsSchema` in
 * `core/workflow-helper/src/types/TriggerOpts.ts`. Read loosely here
 * since Configuration validated the schema at workflow load.
 */
interface SSETriggerConfig {
	path: string;
	heartbeatInterval?: number; // ms; default 15000
	retryInterval?: number; // ms; emitted as SSE retry: field; default 3000
	maxConnections?: number; // hard cap on concurrent streams per process; default 10000
	channels?: string[]; // descriptive only — helper nodes do the actual subscribe
	middleware?: string[]; // trigger-level middleware chain
}

interface HttpTriggerLike {
	addPreCatchAllHook(cb: () => void | Promise<void>): void;
}

/** Internal per-stream state. */
interface StreamState {
	id: string;
	stream: SSEStreamingApi;
	workflowName: string;
	path: string;
	pathParams: Record<string, string>;
	openedAt: number;
	eventsSent: number;
	lastEventId: string | null;
	closed: boolean;
	heartbeatTimer: NodeJS.Timeout | null;
	abortController: AbortController;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RETRY_INTERVAL_MS = 3_000;
const DEFAULT_MAX_CONNECTIONS = 10_000;

// -----------------------------------------------------------------------------
// Trigger class
// -----------------------------------------------------------------------------

export default class SSETrigger extends TriggerBase {
	protected nodeMap: RunnerGlobalOptions = {} as RunnerGlobalOptions;

	protected readonly logger = new DefaultLogger();

	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-sse-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);

	private readonly meter = metrics.getMeter("blok");
	private readonly counterStreamsOpened = this.meter.createCounter("blok_sse_streams_opened_total", {
		description: "SSE streams opened (cumulative).",
		unit: "1",
	});
	private readonly counterEventsSent = this.meter.createCounter("blok_sse_events_sent_total", {
		description: "SSE events written to clients per workflow.",
		unit: "1",
	});
	private readonly counterStreamsRejected = this.meter.createCounter("blok_sse_streams_rejected_total", {
		description: "SSE upgrade refusals (capacity, no handler).",
		unit: "1",
	});

	// Hono's strict-types generic propagation through middleware chains
	// doesn't compose with `streamSSE`'s loose `Context` parameter. We
	// type the trigger's `app` field the same `<any, any, any>` shape
	// used by WebSocketTrigger to stay tolerant of any concrete Hono.
	// biome-ignore lint/suspicious/noExplicitAny: Hono's generic propagation
	private readonly app: Hono<any, any, any>;
	private readonly httpTrigger: HttpTriggerLike | null;

	private streams: Map<string, StreamState> = new Map();

	private wired = false;

	/**
	 * @param app          Shared Hono app (typically from HttpTrigger).
	 *                     SSE routes mount on the same instance so HTTP +
	 *                     WS + SSE multiplex on one TCP port.
	 * @param httpTrigger  Optional HttpTrigger-like object exposing
	 *                     `addPreCatchAllHook`. When provided, SSE routes
	 *                     register inside the pre-catch-all hook so they
	 *                     win Hono's first-match dispatch over the
	 *                     legacy workflow-name catch-all.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: matches `app` field's any generic
	constructor(app: Hono<any, any, any>, httpTrigger?: HttpTriggerLike) {
		super();
		this.app = app;
		this.httpTrigger = httpTrigger ?? null;
		_setActiveSSETrigger(this);
	}

	/**
	 * Inject the runner's GlobalOptions (nodes + workflows). Called by
	 * the orchestrator AFTER constructing the trigger but BEFORE
	 * `listen()`. Shares HttpTrigger's nodeMap so per-stream workflow
	 * runs resolve helper nodes (`@blokjs/sse-subscribe`,
	 * `@blokjs/sse-stream`, `branch`, etc.).
	 */
	setNodeMap(nodeMap: RunnerGlobalOptions): void {
		this.nodeMap = nodeMap;
	}

	async listen(): Promise<number> {
		const startTime = this.startCounter();

		if (this.wired) {
			this.logger.log("[blok][sse] listen() called twice; ignoring");
			return this.endCounter(startTime);
		}
		this.wired = true;

		// Defer route registration to HttpTrigger's pre-catch-all hook so
		// the WorkflowRegistry is fully populated AND our routes are
		// mounted BEFORE the `/:workflow{.+}` catch-all that would
		// otherwise swallow `/sse/<path>` requests as workflow names.
		// When no httpTrigger is provided (tests), register inline —
		// the caller is responsible for ensuring registry is populated
		// before they fetch().
		if (this.httpTrigger) {
			this.httpTrigger.addPreCatchAllHook(() => {
				this.registerRoutesFromRegistry();
			});
		} else {
			this.registerRoutesFromRegistry();
		}

		return this.endCounter(startTime);
	}

	async stop(): Promise<void> {
		// Close every open stream cleanly.
		for (const state of this.streams.values()) {
			this.closeStream(state, /* viaServer */ true);
		}
		this.streams.clear();
		this.wired = false;
		if (_getActiveSSETrigger() === this) _setActiveSSETrigger(null);
		this.destroyMonitoring();
		this.logger.log("[blok][sse] stopped");
	}

	// ---------------------------------------------------------------------------
	// Route registration
	// ---------------------------------------------------------------------------

	private registerRoutesFromRegistry(): void {
		const workflows = this.getSSEWorkflows();
		if (workflows.length === 0) {
			this.logger.log("[blok][sse] no workflows with trigger.sse found");
			return;
		}
		this.logger.log(`[blok][sse] registering ${workflows.length} SSE route(s):`);
		for (const entry of workflows) {
			this.registerSSERoute(entry);
		}
	}

	private registerSSERoute(entry: { workflowName: string; config: SSETriggerConfig }): void {
		const { workflowName, config } = entry;
		this.logger.log(`[blok][sse]   GET     ${config.path}  ←  ${workflowName}`);

		this.app.get(config.path, (c: HonoContext) => {
			const cap = typeof config.maxConnections === "number" ? config.maxConnections : DEFAULT_MAX_CONNECTIONS;
			if (this.streams.size >= cap) {
				this.counterStreamsRejected.add(1, { workflow_name: workflowName, reason: "max_connections" });
				return c.text("SSE capacity exceeded", 503);
			}

			const lastEventId = c.req.header("Last-Event-ID") || c.req.header("last-event-id") || null;
			const pathParams = c.req.param() as Record<string, string>;
			const queryParams = Object.fromEntries(new URL(c.req.url).searchParams);
			const headers = Object.fromEntries(c.req.raw.headers);

			return streamSSE(c, async (honoStream) => {
				const streamId = uuid();
				const abortController = new AbortController();
				const state: StreamState = {
					id: streamId,
					stream: honoStream,
					workflowName,
					path: config.path,
					pathParams,
					openedAt: Date.now(),
					eventsSent: 0,
					lastEventId,
					closed: false,
					heartbeatTimer: null,
					abortController,
				};
				this.streams.set(streamId, state);
				this.counterStreamsOpened.add(1, { workflow_name: workflowName });

				// Bridge Hono's onAbort → our AbortController so workflow
				// authors can `if (ctx.stream.signal.aborted) break` in
				// long iterators without depending on the Hono API.
				honoStream.onAbort(() => {
					state.closed = true;
					abortController.abort();
					this.stopHeartbeat(state);
				});

				// Initial retry hint — clients honor it on reconnect.
				if (typeof config.retryInterval === "number" && config.retryInterval > 0) {
					await honoStream.writeSSE({ data: "", retry: config.retryInterval }).catch(() => {});
				} else {
					await honoStream.writeSSE({ data: "", retry: DEFAULT_RETRY_INTERVAL_MS }).catch(() => {});
				}

				this.startHeartbeat(state, config);

				try {
					await this.dispatchStream({
						state,
						config,
						headers,
						queryParams,
					});
				} finally {
					this.closeStream(state, /* viaServer */ false);
				}
			});
		});
	}

	// ---------------------------------------------------------------------------
	// Workflow dispatch (one run per stream open — Pattern A)
	// ---------------------------------------------------------------------------

	private async dispatchStream(opts: {
		state: StreamState;
		config: SSETriggerConfig;
		headers: Record<string, string>;
		queryParams: Record<string, string>;
	}): Promise<void> {
		const { state, config: _config, headers, queryParams } = opts;
		const { workflowName, id: streamId, pathParams } = state;
		const requestId = uuid();

		await this.tracer.startActiveSpan(`sse:${workflowName}:open`, async (span: Span) => {
			try {
				const registry = WorkflowRegistry.getInstance();
				const entry = registry.get(workflowName);
				if (!entry) {
					throw new Error(`[blok][sse] workflow "${workflowName}" not found in registry`);
				}
				await this.configuration.init(workflowName, this.nodeMap, entry.workflow);

				const ctx: Context = this.createContext(undefined, workflowName, requestId);
				ctx.request = {
					body: {},
					headers,
					params: pathParams,
					query: queryParams,
				} as unknown as RequestContext;

				ctx.stream = this.buildStreamContext(state);

				await this.applyMiddlewareChain(ctx, this.nodeMap);
				await this.run(ctx);

				span.setAttribute("workflow_name", workflowName);
				span.setAttribute("stream_id", streamId);
				span.setAttribute("events_sent", state.eventsSent);
				span.setStatus({ code: SpanStatusCode.OK });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				span.recordException(err as Error);
				span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
				this.logger.error(`[blok][sse] sse:open workflow ${workflowName} failed: ${msg}`);
			} finally {
				span.end();
			}
		});
	}

	private buildStreamContext(state: StreamState): StreamContext {
		const trigger = this;
		const streamId = state.id;
		return {
			get id() {
				return streamId;
			},
			get lastEventId() {
				return state.lastEventId;
			},
			get closed() {
				return state.closed;
			},
			get signal() {
				return state.abortController.signal;
			},
			async writeSSE({ event, data, id, retry }) {
				if (state.closed) return;
				const payload = typeof data === "string" ? data : JSON.stringify(data);
				try {
					await state.stream.writeSSE({
						data: payload,
						...(event ? { event } : {}),
						...(id ? { id } : {}),
						...(typeof retry === "number" ? { retry } : {}),
					});
					state.eventsSent += 1;
					trigger.counterEventsSent.add(1, { workflow_name: state.workflowName });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					trigger.logger.error(`[blok][sse] writeSSE failed on ${streamId}: ${msg}`);
				}
			},
			async writeComment(text) {
				if (state.closed) return;
				try {
					// SSE comment frame: starts with `:` and ends with `\n\n`.
					await state.stream.write(`: ${text}\n\n`);
				} catch {
					/* connection closed — swallow */
				}
			},
			close() {
				trigger.closeStream(state, /* viaServer */ false);
			},
			subscribe(channels, lastEventId) {
				// Resolve `{paramName}` placeholders in channel names
				// against the trigger's path params — `"order:{orderId}"`
				// becomes `"order:42"` when the GET path was `/sse/orders/42`.
				const resolved = channels.map((channel) =>
					channel.replace(/\{(\w+)\}/g, (_, key) => state.pathParams[key] ?? `{${key}}`),
				);
				const since = lastEventId ?? state.lastEventId ?? undefined;
				return getBus().subscribe(resolved, since);
			},
		};
	}

	private closeStream(state: StreamState, viaServer: boolean): void {
		if (state.closed && !viaServer) return;
		state.closed = true;
		this.stopHeartbeat(state);
		state.abortController.abort();
		if (viaServer) {
			try {
				void state.stream.close();
			} catch {
				/* ignore */
			}
		}
		this.streams.delete(state.id);
	}

	// ---------------------------------------------------------------------------
	// Heartbeat (`: keep-alive` comment frames)
	// ---------------------------------------------------------------------------

	private startHeartbeat(state: StreamState, config: SSETriggerConfig): void {
		const intervalMs =
			typeof config.heartbeatInterval === "number" && config.heartbeatInterval > 0
				? config.heartbeatInterval
				: DEFAULT_HEARTBEAT_INTERVAL_MS;
		state.heartbeatTimer = setInterval(() => {
			if (state.closed) {
				this.stopHeartbeat(state);
				return;
			}
			void state.stream.write(": keep-alive\n\n").catch(() => {});
		}, intervalMs);
		if (typeof state.heartbeatTimer.unref === "function") state.heartbeatTimer.unref();
	}

	private stopHeartbeat(state: StreamState): void {
		if (state.heartbeatTimer) {
			clearInterval(state.heartbeatTimer);
			state.heartbeatTimer = null;
		}
	}

	// ---------------------------------------------------------------------------
	// Read-only stats / introspection
	// ---------------------------------------------------------------------------

	getStats(): { streams: number; workflows: number } {
		const workflowSet = new Set<string>();
		for (const s of this.streams.values()) workflowSet.add(s.workflowName);
		return { streams: this.streams.size, workflows: workflowSet.size };
	}

	private getSSEWorkflows(): Array<{ workflowName: string; config: SSETriggerConfig }> {
		const registry = WorkflowRegistry.getInstance();
		const out: Array<{ workflowName: string; config: SSETriggerConfig }> = [];
		for (const entry of registry.list()) {
			const wf = entry.workflow as { trigger?: { sse?: SSETriggerConfig } } | undefined;
			const sseCfg = wf?.trigger?.sse;
			if (!sseCfg || typeof sseCfg.path !== "string") continue;
			out.push({ workflowName: entry.name, config: sseCfg });
		}
		return out;
	}
}

// -----------------------------------------------------------------------------
// Singleton accessor for helper nodes
// -----------------------------------------------------------------------------

/**
 * Singleton handle — helper nodes (`@blokjs/sse-publish`) look up the
 * active SSE trigger to publish into the in-process bus through the
 * same code path as the trigger's internal subscribers. Not used by
 * the per-stream `ctx.stream` API — that's bound directly per run.
 */
let activeTrigger: SSETrigger | null = null;

export function _setActiveSSETrigger(trigger: SSETrigger | null): void {
	activeTrigger = trigger;
}

export function _getActiveSSETrigger(): SSETrigger | null {
	return activeTrigger;
}

export type { SSETriggerConfig };
