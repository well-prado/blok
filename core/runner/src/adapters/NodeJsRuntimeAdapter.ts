import type { Context } from "@nanoservice-ts/shared";
import type RunnerNode from "../RunnerNode";
import type { ExecutionResult, RuntimeAdapter } from "./RuntimeAdapter";

/**
 * NodeJsRuntimeAdapter executes TypeScript/JavaScript nodes in-process
 *
 * This adapter handles both:
 * - Module nodes: Nodes loaded from the NodeMap (registered npm packages)
 * - Local nodes: Nodes loaded from the local filesystem
 *
 * Execution happens in the same Node.js process with zero gRPC/HTTP overhead.
 */
export class NodeJsRuntimeAdapter implements RuntimeAdapter {
	public readonly kind = "nodejs";

	/**
	 * Execute a Node.js node in-process
	 *
	 * @param node - The node instance to execute (already resolved/instantiated)
	 * @param ctx - The workflow execution context
	 * @returns Promise that resolves to ExecutionResult
	 */
	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();

		try {
			// Execute the node's run method
			const response = await node.run(ctx);

			const duration_ms = performance.now() - startTime;

			// Convert ResponseContext to ExecutionResult
			return {
				success: response.success ?? true,
				data: response.data,
				errors: response.error || null,
				metrics: {
					duration_ms,
				},
			};
		} catch (error: unknown) {
			const duration_ms = performance.now() - startTime;

			return {
				success: false,
				data: null,
				errors: {
					message: (error as Error).message,
					stack: (error as Error).stack,
					name: (error as Error).name,
				},
				metrics: {
					duration_ms,
				},
			};
		}
	}
}
