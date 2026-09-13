import type { Context } from "@blokjs/shared";
import BlokService from "../Blok";
import type { IBlokResponse } from "../BlokResponse";
import type RunnerNode from "../RunnerNode";
import type { ExecutionResult, RuntimeAdapter } from "./RuntimeAdapter";

/**
 * BunRuntimeAdapter executes TypeScript/JavaScript nodes using Bun runtime
 *
 * This adapter provides:
 * - In-process execution when running under Bun (fastest path)
 * - Fail-closed behavior when the runner is not hosted by Bun
 *
 * When the host process IS Bun, execution is identical to NodeJsRuntimeAdapter
 * (in-process, zero overhead). Cross-host execution requires the persistent
 * worker slice; this adapter never starts a process per step.
 */
export class BunRuntimeAdapter implements RuntimeAdapter {
	public readonly kind = "bun" as const;
	public readonly transport = "module" as const;
	private isBunRuntime: boolean;

	constructor() {
		// Detect if we're running under Bun
		this.isBunRuntime = typeof globalThis !== "undefined" && "Bun" in globalThis;
	}

	static isAvailable(): boolean {
		return typeof globalThis !== "undefined" && "Bun" in globalThis;
	}

	/**
	 * Execute a node using Bun runtime
	 *
	 * @param node - The node instance to execute
	 * @param ctx - The workflow execution context
	 * @returns Promise that resolves to ExecutionResult
	 */
	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		if (this.isBunRuntime) {
			return this.executeInProcess(node, ctx);
		}
		return {
			success: false,
			data: null,
			errors: {
				message:
					"runtime.bun cannot execute in-process: this runner is not hosted by Bun. Configuration registers the persistent Bun worker (gRPC) for this case — reaching this branch means the adapter was registered manually on a mismatched host.",
			},
		};
	}

	/**
	 * Execute in-process when running under Bun (zero overhead)
	 * Same as NodeJsRuntimeAdapter since Bun is API-compatible with Node.js
	 */
	private async executeInProcess(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();

		try {
			const response = await node.run(ctx);

			const duration_ms = performance.now() - startTime;

			const responseData = node instanceof BlokService ? (response.data as IBlokResponse) : undefined;
			const topLevelResponse = response as { error?: unknown; success?: boolean; data?: unknown };

			const nestedError = responseData?.error !== null && responseData?.error !== undefined;
			const topLevelError = topLevelResponse?.error !== null && topLevelResponse?.error !== undefined;
			const hasError = nestedError || topLevelError;

			const nestedSuccess = responseData?.success;
			const topLevelSuccess = topLevelResponse?.success;
			const success = hasError ? false : (nestedSuccess ?? topLevelSuccess ?? true);
			const data = responseData ? responseData.data : response.data;

			const errorValue = responseData?.error || topLevelResponse?.error || null;

			return {
				success,
				data,
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
