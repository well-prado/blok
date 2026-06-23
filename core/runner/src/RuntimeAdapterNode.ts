import type { Context, ResponseContext } from "@blokjs/shared";
import { GlobalError } from "@blokjs/shared";
import RunnerNode from "./RunnerNode";
import type { ExecutionResult, RuntimeAdapter } from "./adapters/RuntimeAdapter";
import type { DecodedExecuteEvent } from "./adapters/grpc/GrpcCodec";
import { RunTracker } from "./tracing/RunTracker";
import type { TraceLogEntry } from "./tracing/types";
import { applyStepOutput } from "./workflow/PersistenceHelper";

/**
 * RuntimeAdapterNode is a wrapper that bridges the existing RunnerNode interface
 * with the new RuntimeAdapter system.
 *
 * This allows runtime adapters to be used seamlessly within the existing
 * workflow execution engine without breaking changes.
 */
export class RuntimeAdapterNode extends RunnerNode {
	private adapter: RuntimeAdapter;
	private targetNode: RunnerNode;
	private streamLogs: boolean;
	/**
	 * Live data-event destination for this node's `PartialResult` frames.
	 * `"sse"` forwards each partial to `ctx.stream.writeSSE(...)` AS IT
	 * ARRIVES (inside `runStreaming`'s for-await loop) so a long-running
	 * runtime node can stream tokens / tool-calls / sources to an
	 * SSE-triggered client live, before its terminal result lands.
	 * Undefined (default) preserves the prior behaviour — partials only
	 * reach the tracer. Opt-in via step `streamTo: "sse"` / `stream: true`.
	 */
	private streamTo?: string;

	/**
	 * Wire transport this node uses (`http` | `grpc` | `module`). Surfaced
	 * in the step-prefix log by `RunnerSteps` so operators can tell at a
	 * glance which path a runtime node took during the migration. Read-only;
	 * mirrors the underlying adapter's `transport` field.
	 */
	public readonly transport: RuntimeAdapter["transport"];

	constructor(adapter: RuntimeAdapter, targetNode: RunnerNode, opts: { streamLogs?: boolean; streamTo?: string } = {}) {
		super();
		this.adapter = adapter;
		this.targetNode = targetNode;
		this.streamLogs = opts.streamLogs === true;
		this.streamTo = opts.streamTo;
		this.transport = adapter.transport;
		// Copy properties from target node
		this.node = targetNode.node;
		this.name = targetNode.name;
		this.type = targetNode.type;
		this.runtime = targetNode.runtime;
		this.active = targetNode.active;
		this.stop = targetNode.stop;
		// V2 persistence knobs — flow through to PersistenceHelper.
		this.as = targetNode.as;
		this.spread = targetNode.spread;
		this.ephemeral = targetNode.ephemeral;
	}

	/**
	 * Execute the node using the runtime adapter.
	 *
	 * When `streamLogs=true` AND the adapter exposes `executeStream`, routes
	 * through the server-streaming path so node-emitted `LogLine` events flow
	 * into the tracker (and thus into Studio's SSE stream) live. Falls back
	 * to unary `execute` when streaming isn't enabled or isn't supported by
	 * this adapter (the in-process NodeJsRuntimeAdapter has no streaming
	 * surface, for instance).
	 */
	async run(ctx: Context): Promise<ResponseContext> {
		const traceRunId = (ctx as Record<string, unknown>)._traceRunId as string | undefined;
		const traceNodeId = (ctx as Record<string, unknown>)._traceNodeId as string | undefined;
		const tracker = traceRunId ? RunTracker.getInstance() : null;

		const result = this.canStream()
			? await this.runStreaming(ctx, tracker, traceRunId, traceNodeId)
			: await this.adapter.execute(this.targetNode, ctx);

		// --- Trace: stash runtime metrics on ctx so RunnerSteps can pass
		// them to `tracker.completeNode(...)` as the third argument. The
		// previous in-place mutation via `tracker.getNodeRun()` was a
		// dead-end: SqliteRunStore.getNodeRun reconstructs from a row, so
		// the mutation landed on a detached object; even on InMemoryRunStore
		// the next `completeNode(nodeRunId, outputs)` call wrote
		// `metrics: undefined` over it. Stashing on ctx and threading
		// through `completeNode` is the single path that survives all
		// store implementations and the NODE_COMPLETED event payload.
		if (result.metrics) {
			(ctx as Record<string, unknown>)._stepMetrics = result.metrics;
		}

		// Surface the SDK's intended response Content-Type on a ctx side-channel
		// (NOT on the returned data) so the trigger can map it to the HTTP
		// `Content-Type` header. Runtime nodes leave their raw return value on
		// `ctx.response`, so there is no envelope to carry the content-type —
		// folding it into the data object would leak a spurious `contentType`
		// key into the response body. `RunnerSteps` resets this slot before
		// every step, so after the run it reflects the LAST step only.
		if (typeof result.contentType === "string" && result.contentType.length > 0) {
			(ctx as Record<string, unknown>)._stepContentType = result.contentType;
		}

		// Defensive: ensure state exists. TriggerBase initializes it, but
		// some legacy code paths construct ctx by hand. ctx.vars and
		// ctx.state alias the same object; we read/write through `state`.
		if (!ctx.state || typeof ctx.state !== "object") {
			(ctx as { state: Record<string, unknown> }).state = {};
		}
		const state = ctx.state as Record<string, unknown>;

		// Merge SDK-returned `vars_delta` into state. This is the SDK's
		// explicit publication path (proto field `vars_delta` on
		// ExecuteResponse) — it stacks with the auto-store rule below.
		if (result.vars && typeof result.vars === "object") {
			Object.assign(state, result.vars);
		}

		// V2 persistence — runner-owned, declarative.
		// `ephemeral` skips, `spread` merges, `as` renames, default stores
		// at state[name]. SDK nodes have always auto-stored (today's
		// behaviour); this just routes through the unified helper.
		applyStepOutput(ctx, this, result);

		// Convert errors to GlobalError if present
		let error: GlobalError | null = null;
		if (result.errors) {
			if (result.errors instanceof GlobalError) {
				error = result.errors;
			} else if (typeof result.errors === "object" && result.errors !== null) {
				const err = result.errors as { message?: string; stack?: string; name?: string };
				error = new GlobalError(err.message || "Runtime execution error");
				if (err.stack) error.setStack(err.stack);
				if (err.name) error.setName(err.name);
			} else {
				error = new GlobalError(String(result.errors));
			}
		}

		// Convert ExecutionResult to ResponseContext
		return {
			success: result.success,
			data: result.data,
			error,
		};
	}

	/**
	 * True when streaming is enabled for this node AND the adapter exposes a
	 * server-streaming `executeStream` method. The shape check is
	 * intentionally duck-typed so any future adapter that implements
	 * streaming Just Works without coupling this class to GrpcRuntimeAdapter.
	 */
	private canStream(): boolean {
		// Streaming is engaged when EITHER live-log forwarding (`streamLogs`)
		// OR live data-event forwarding (`streamTo: "sse"`) is requested. Both
		// drain the same `executeStream` surface; the for-await loop routes
		// `log` frames to the tracker and `partial` frames to `ctx.stream`.
		if (!this.streamLogs && this.streamTo !== "sse") return false;
		const candidate = this.adapter as unknown as { executeStream?: unknown };
		return typeof candidate.executeStream === "function";
	}

	/**
	 * Run the node via the adapter's streaming surface, draining log frames
	 * into `RunTracker.addLog` as they arrive. Returns the same
	 * `ExecutionResult` shape as the unary path so callers handle both flows
	 * identically.
	 */
	private async runStreaming(
		ctx: Context,
		tracker: RunTracker | null,
		traceRunId: string | undefined,
		traceNodeId: string | undefined,
	): Promise<ExecutionResult> {
		const streamingAdapter = this.adapter as unknown as {
			executeStream: (
				node: RunnerNode,
				ctx: Context,
			) => { events: AsyncIterable<DecodedExecuteEvent>; result: Promise<ExecutionResult> };
		};
		const { events, result } = streamingAdapter.executeStream(this.targetNode, ctx);

		// Live SSE forwarding is engaged only when the step opted in AND the
		// run is under an SSE trigger (so `ctx.stream` exists). Captured once
		// so the per-event branch stays a cheap field read.
		const sseStream = this.streamTo === "sse" ? ctx.stream : undefined;

		for await (const event of events) {
			if (event.type === "log" && tracker && traceRunId) {
				tracker.addLog({
					runId: traceRunId,
					nodeId: traceNodeId,
					nodeName: this.name,
					level: normalizeLogLevel(event.log.level),
					message: event.log.message,
					data: Object.keys(event.log.attributes).length > 0 ? event.log.attributes : undefined,
				} satisfies Omit<TraceLogEntry, "id" | "timestamp">);
			} else if (event.type === "progress" && tracker && traceNodeId) {
				// Live progress hint — overwrites any previous;
				// emits NODE_PROGRESS for Studio SSE.
				tracker.recordProgress(traceNodeId, event.percent, event.phase);
			} else if (event.type === "partial") {
				// Interim snapshot. Always recorded for Studio observability;
				// additionally forwarded LIVE to the SSE client when the step
				// opted into `streamTo: "sse"`.
				if (tracker && traceNodeId) {
					tracker.recordPartialResult(traceNodeId, event.snapshot);
				}
				// Forward to the client unless they've disconnected. On
				// disconnect we intentionally KEEP draining the iterator (no
				// `break`) so the underlying node still runs to completion and
				// its terminal result is persisted — only the client writes
				// stop. `writeSSE` is already a no-op after `close()`, but the
				// `aborted`/`closed` guard avoids the await + JSON encode work.
				if (sseStream && !sseStream.closed && !sseStream.signal.aborted) {
					try {
						await sseStream.writeSSE(partialToSSE(event.snapshot));
					} catch {
						// A write failure (client vanished mid-frame) must not
						// abort the node — swallow and keep draining.
					}
				}
			}
			// `started` is intentionally ignored at this layer — the
			// node lifecycle (NodeStarted / metrics / completion) is
			// already tracked by RunnerSteps via `startNode` /
			// `completeNode`.
		}

		return result;
	}
}

/**
 * Map a `PartialResult` snapshot (arbitrary JSON the runtime node emitted
 * via `ctx.emit(...)`) into the `writeSSE` argument shape.
 *
 * Two emit conventions are supported so producers choose their ergonomics:
 *  - **Framed**: emit `{ event?, data, id?, retry? }` — the producer (which
 *    holds the semantic context: "this delta is `text` vs `tool_call`")
 *    names the SSE event directly. Detected by an own `data` property.
 *  - **Raw**: emit any other value — the whole snapshot becomes the frame
 *    `data` with no explicit event name.
 */
function partialToSSE(snapshot: unknown): {
	event?: string;
	data: unknown;
	id?: string;
	retry?: number;
} {
	if (snapshot !== null && typeof snapshot === "object" && Object.hasOwn(snapshot, "data")) {
		const framed = snapshot as { event?: unknown; data: unknown; id?: unknown; retry?: unknown };
		return {
			event: typeof framed.event === "string" ? framed.event : undefined,
			data: framed.data,
			id: typeof framed.id === "string" ? framed.id : undefined,
			retry: typeof framed.retry === "number" ? framed.retry : undefined,
		};
	}
	return { data: snapshot };
}

/**
 * Coerce a wire-side log level string into the runner's 4-tier
 * `TraceLogEntry["level"]`. Defensive against SDK-side variations
 * ("warning" → "warn", "WARN" → "warn", unknown → "info").
 */
function normalizeLogLevel(level: string): TraceLogEntry["level"] {
	const normalized = level.trim().toLowerCase();
	switch (normalized) {
		case "debug":
		case "info":
		case "error":
			return normalized;
		case "warn":
		case "warning":
			return "warn";
		default:
			return "info";
	}
}
