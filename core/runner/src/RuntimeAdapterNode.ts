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
	 * Wire transport this node uses (`http` | `grpc` | `module`). Surfaced
	 * in the step-prefix log by `RunnerSteps` so operators can tell at a
	 * glance which path a runtime node took during the migration. Read-only;
	 * mirrors the underlying adapter's `transport` field.
	 */
	public readonly transport: RuntimeAdapter["transport"];

	constructor(adapter: RuntimeAdapter, targetNode: RunnerNode, opts: { streamLogs?: boolean } = {}) {
		super();
		this.adapter = adapter;
		this.targetNode = targetNode;
		this.streamLogs = opts.streamLogs === true;
		this.transport = adapter.transport;
		// Copy properties from target node
		this.node = targetNode.node;
		this.name = targetNode.name;
		this.type = targetNode.type;
		this.runtime = targetNode.runtime;
		this.active = targetNode.active;
		this.stop = targetNode.stop;
		this.set_var = targetNode.set_var;
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
	 * this adapter (e.g. HttpRuntimeAdapter has no streaming surface).
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
		if (!this.streamLogs) return false;
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
			} else if (event.type === "partial" && tracker && traceNodeId) {
				// Interim snapshot — overwrites any previous;
				// emits NODE_PARTIAL_RESULT for Studio SSE.
				tracker.recordPartialResult(traceNodeId, event.snapshot);
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
