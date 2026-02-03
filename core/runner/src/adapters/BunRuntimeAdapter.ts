import type { Context } from "@blokjs/shared";
import type RunnerNode from "../RunnerNode";
import type { ExecutionResult, RuntimeAdapter } from "./RuntimeAdapter";

/**
 * BunRuntimeAdapter executes TypeScript/JavaScript nodes using Bun runtime
 *
 * This adapter provides:
 * - In-process execution when running under Bun (fastest path)
 * - Subprocess execution via `bun run` when running under Node.js
 * - Compatible with both Node.js and Bun execution environments
 *
 * When the host process IS Bun, execution is identical to NodeJsRuntimeAdapter
 * (in-process, zero overhead). When the host is Node.js, it spawns a Bun
 * subprocess for execution.
 */
export class BunRuntimeAdapter implements RuntimeAdapter {
	public readonly kind = "bun" as const;
	private isBunRuntime: boolean;

	constructor() {
		// Detect if we're running under Bun
		this.isBunRuntime = typeof globalThis !== "undefined" && "Bun" in globalThis;
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
		return this.executeViaSubprocess(node, ctx);
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

			const responseData = response.data as { error?: unknown; success?: boolean; data?: unknown } | null | undefined;
			const topLevelResponse = response as { error?: unknown; success?: boolean; data?: unknown };

			const nestedError = responseData?.error !== null && responseData?.error !== undefined;
			const topLevelError = topLevelResponse?.error !== null && topLevelResponse?.error !== undefined;
			const hasError = nestedError || topLevelError;

			const nestedSuccess = responseData?.success;
			const topLevelSuccess = topLevelResponse?.success;
			const success = hasError ? false : (nestedSuccess ?? topLevelSuccess ?? true);

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

	/**
	 * Execute via Bun subprocess when host is Node.js
	 * Spawns `bun run` to execute the node in a Bun process
	 */
	private async executeViaSubprocess(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();

		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);

			// Prepare the execution payload
			const payload = JSON.stringify({
				node: {
					name: node.node || node.name,
					type: node.type,
				},
				context: {
					id: ctx.id,
					workflow_name: ctx.workflow_name,
					workflow_path: ctx.workflow_path,
					request: {
						body: ctx.request.body,
						headers: ctx.request.headers,
						params: ctx.request.params,
						query: ctx.request.query,
					},
					response: ctx.response,
					vars: ctx.vars,
				},
			});

			// Execute via bun with inline script that loads and runs the node
			const script = `
				const payload = JSON.parse(process.argv[1]);
				const mod = await import(payload.node.name);
				const nodeInstance = mod.default || mod;
				if (typeof nodeInstance.run === 'function') {
					const result = await nodeInstance.run(payload.context);
					console.log(JSON.stringify({ success: true, data: result.data, errors: result.error || null }));
				} else if (typeof nodeInstance.execute === 'function') {
					const result = await nodeInstance.execute(payload.context, payload.context.request.body);
					console.log(JSON.stringify({ success: true, data: result, errors: null }));
				} else {
					console.log(JSON.stringify({ success: false, data: null, errors: { message: 'No run or execute method found' } }));
				}
			`;

			const { stdout, stderr } = await execFileAsync("bun", ["eval", script, payload], {
				timeout: 30000,
				maxBuffer: 10 * 1024 * 1024,
			});

			const duration_ms = performance.now() - startTime;

			let result: ExecutionResult;
			try {
				const parsed = JSON.parse(stdout.trim());
				result = {
					success: parsed.success ?? true,
					data: parsed.data,
					errors: parsed.errors || null,
					logs: stderr ? [stderr] : undefined,
					metrics: {
						duration_ms,
					},
				};
			} catch {
				result = {
					success: true,
					data: stdout.trim(),
					errors: null,
					logs: stderr ? [stderr] : undefined,
					metrics: {
						duration_ms,
					},
				};
			}

			return result;
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
