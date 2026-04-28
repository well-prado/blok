import type { Context, ResponseContext } from "@blokjs/shared";
import { GlobalError } from "@blokjs/shared";
import RunnerNode from "./RunnerNode";
import type { ExecutionResult, RuntimeAdapter } from "./adapters/RuntimeAdapter";
import type { DecodedExecuteEvent } from "./adapters/grpc/GrpcCodec";
import { RunTracker } from "./tracing/RunTracker";
import type { TraceLogEntry } from "./tracing/types";

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

	constructor(adapter: RuntimeAdapter, targetNode: RunnerNode, opts: { streamLogs?: boolean } = {}) {
		super();
		this.adapter = adapter;
		this.targetNode = targetNode;
		this.streamLogs = opts.streamLogs === true;
		// Copy properties from target node
		this.node = targetNode.node;
		this.name = targetNode.name;
		this.type = targetNode.type;
		this.runtime = targetNode.runtime;
		this.active = targetNode.active;
		this.stop = targetNode.stop;
		this.set_var = targetNode.set_var;
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

		// --- Trace: capture runtime metrics ---
		if (tracker && traceNodeId && result.metrics) {
			const nodeRun = tracker.getNodeRun(traceNodeId);
			if (nodeRun) {
				nodeRun.metrics = {
					duration_ms: result.metrics.duration_ms,
					cpu_ms: result.metrics.cpu_ms,
					memory_bytes: result.metrics.memory_bytes,
				};
				nodeRun.runtimeKind = this.adapter.kind;
			}
		}

		// Ensure ctx.vars exists
		if (!ctx.vars) {
			(ctx as Record<string, unknown>).vars = {};
		}
		const vars = ctx.vars as Record<string, unknown>;

		// Merge SDK-returned vars into ctx.vars (if the SDK server includes them)
		if (result.vars && typeof result.vars === "object") {
			Object.assign(vars, result.vars);
		}

		// Auto-save the step's result data into ctx.vars[stepName]
		// This ensures each runtime step's output is accessible downstream,
		// even if the SDK server doesn't explicitly return vars
		if (result.data != null) {
			vars[this.name] = result.data;
		}

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
			}
			// `started`/`progress`/`partial` frames are intentionally ignored at
			// this layer for now — the node lifecycle (NodeStarted / metrics /
			// completion) is already tracked by RunnerSteps via `startNode` /
			// `completeNode`. Wiring richer progress UI into Studio is a
			// follow-up that doesn't change the wire contract.
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
