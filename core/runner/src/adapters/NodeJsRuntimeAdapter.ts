import type { Context } from "@blokjs/shared";
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
	public readonly transport = "module" as const;

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
			// Response can be either:
			// 1. ResponseContext with nested data: { data: { success, data, error } }
			// 2. Direct response: { success, data, error }
			const responseData = response.data as { error?: unknown; success?: boolean; data?: unknown } | null | undefined;
			const topLevelResponse = response as { error?: unknown; success?: boolean; data?: unknown };

			// Check for errors at both nested level (response.data.error) and top level (response.error)
			const nestedError = responseData?.error !== null && responseData?.error !== undefined;
			const topLevelError = topLevelResponse?.error !== null && topLevelResponse?.error !== undefined;
			const hasError = nestedError || topLevelError;

			// Determine success: check both levels, default to true if not specified
			const nestedSuccess = responseData?.success;
			const topLevelSuccess = topLevelResponse?.success;
			const success = hasError ? false : (nestedSuccess ?? topLevelSuccess ?? true);

			// Get error from whichever level has it
			const errorValue = responseData?.error || topLevelResponse?.error || null;

			return {
				success,
				data: response.data,
				errors: errorValue,
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
