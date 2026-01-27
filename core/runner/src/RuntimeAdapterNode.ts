import type { Context, ResponseContext } from "@nanoservice-ts/shared";
import { GlobalError } from "@nanoservice-ts/shared";
import RunnerNode from "./RunnerNode";
import type { RuntimeAdapter } from "./adapters/RuntimeAdapter";

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
