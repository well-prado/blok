import type { Context, ResponseContext } from "@blok/shared";
import { GlobalError } from "@blok/shared";
import RunnerNode from "./RunnerNode";
import type { RuntimeAdapter } from "./adapters/RuntimeAdapter";
import { RunTracker } from "./tracing/RunTracker";

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

	constructor(adapter: RuntimeAdapter, targetNode: RunnerNode) {
		super();
		this.adapter = adapter;
		this.targetNode = targetNode;
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
	 * Execute the node using the runtime adapter
	 */
	async run(ctx: Context): Promise<ResponseContext> {
		const result = await this.adapter.execute(this.targetNode, ctx);

		// --- Trace: capture runtime metrics ---
		const traceNodeId = (ctx as Record<string, unknown>)._traceNodeId as string | undefined;
		if (traceNodeId && result.metrics) {
			const tracker = RunTracker.getInstance();
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
}
