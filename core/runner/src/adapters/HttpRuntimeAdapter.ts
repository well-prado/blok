import type { Context } from "@nanoservice-ts/shared";
import type RunnerNode from "../RunnerNode";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "./RuntimeAdapter";

/**
 * Configuration options for HttpRuntimeAdapter
 */
export interface HttpRuntimeAdapterOptions {
	/** Request timeout in milliseconds (default: 30000) */
	timeoutMs?: number;
}

/**
 * HttpRuntimeAdapter executes nodes in pre-existing SDK containers via HTTP.
 *
 * Unlike DockerRuntimeAdapter, this adapter does NOT manage container lifecycle.
 * It connects to already-running containers (managed externally by Docker Compose,
 * Kubernetes, or any other orchestrator).
 *
 * All SDK containers implement the same HTTP contract:
 * - POST /execute  — Execute a node with the provided context
 * - GET  /health   — Return container health status
 *
 * Environment variables per language:
 *   RUNTIME_GO_HOST / RUNTIME_GO_PORT
 *   RUNTIME_RUST_HOST / RUNTIME_RUST_PORT
 *   RUNTIME_JAVA_HOST / RUNTIME_JAVA_PORT
 *   RUNTIME_CSHARP_HOST / RUNTIME_CSHARP_PORT
 *   RUNTIME_PHP_HOST / RUNTIME_PHP_PORT
 *   RUNTIME_RUBY_HOST / RUNTIME_RUBY_PORT
 *   RUNTIME_PYTHON3_HOST / RUNTIME_PYTHON3_PORT
 */
export class HttpRuntimeAdapter implements RuntimeAdapter {
	public readonly kind: RuntimeKind;
	private baseUrl: string;
	private timeoutMs: number;

	constructor(kind: RuntimeKind, host: string, port: number, options?: HttpRuntimeAdapterOptions) {
		this.kind = kind;
		this.baseUrl = `http://${host}:${port}`;
		this.timeoutMs = options?.timeoutMs ?? 30000;
	}

	/**
	 * Execute a node in the SDK container via HTTP POST /execute
	 */
	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();

		try {
			const request = this.createExecutionRequest(node, ctx);

			const response = await fetch(`${this.baseUrl}/execute`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(this.timeoutMs),
			});

			if (!response.ok) {
				throw new Error(
					`HTTP runtime '${this.kind}' at ${this.baseUrl} returned HTTP ${response.status}: ${response.statusText}`,
				);
			}

			const result = (await response.json()) as ExecutionResult;
			const duration_ms = performance.now() - startTime;

			return {
				success: result.success ?? true,
				data: result.data,
				errors: result.errors || null,
				logs: result.logs,
				metrics: {
					duration_ms,
					...(result.metrics || {}),
				},
				vars: result.vars,
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
	 * Create the ExecutionRequest payload for the SDK container.
	 *
	 * Data flow priority:
	 * 1. If the node has resolved inputs (from blueprint Mapper), use those as request.body
	 *    This allows workflows to define explicit inputs like: "chain": "js/ctx.response.data.chain"
	 * 2. Otherwise, fall back to ctx.response.data (previous step output)
	 *    This enables zero-config chaining where SDK nodes automatically receive prior output
	 */
	private createExecutionRequest(node: RunnerNode, ctx: Context): unknown {
		const nodeConfig = ctx.config
			? ((ctx.config as Record<string, unknown>)[node.name] as Record<string, unknown>)
			: {};

		// Check if the Mapper has resolved inputs for this node
		// The Mapper runs BEFORE run() in NodeBase.process(), so by now
		// config[node.name].inputs has resolved values (not raw js/ expressions)
		const resolvedInputs = nodeConfig?.inputs as Record<string, unknown> | undefined;

		// Use resolved inputs if available, otherwise fall back to previous step data
		const requestBody = resolvedInputs || (ctx.response?.data ?? {});

		return {
			node: {
				name: node.node,
				type: node.type,
				config: nodeConfig || {},
			},
			context: {
				id: ctx.id,
				workflow_name: ctx.workflow_name,
				workflow_path: ctx.workflow_path,
				request: {
					body: requestBody,
					headers: ctx.request?.headers ?? {},
					params: ctx.request?.params ?? {},
					query: ctx.request?.query ?? {},
					method: ctx.request?.method ?? "",
					url: ctx.request?.url ?? "",
					cookies: ctx.request?.cookies ?? {},
					baseUrl: ctx.request?.baseUrl ?? "",
				},
				response: {
					data: null,
					contentType: "application/json",
					success: true,
					error: null,
				},
				vars: ctx.vars ?? {},
				env: ctx.env ?? {},
			},
		};
	}

	/**
	 * Check if the SDK container is healthy via GET /health
	 */
	async checkHealth(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/health`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (response.ok) {
				const data = (await response.json()) as { status?: string };
				return data.status === "healthy" || data.status === "ok";
			}

			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Get the base URL for this adapter
	 */
	getBaseUrl(): string {
		return this.baseUrl;
	}
}
