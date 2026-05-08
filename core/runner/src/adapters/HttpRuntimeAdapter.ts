import type { Context } from "@blokjs/shared";
import type RunnerNode from "../RunnerNode";
import { RuntimeRegistry } from "../RuntimeRegistry";
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
	public readonly transport = "http" as const;
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
				// Read the error response body — SDK containers return structured error details
				// that would otherwise be lost (e.g. validation messages, stack traces)
				let errorDetail = "";
				try {
					const errorBody = (await response.json()) as Record<string, unknown>;
					const errors = errorBody?.errors as Record<string, unknown> | undefined;
					errorDetail = (errors?.message as string) || JSON.stringify(errors) || "";
				} catch {
					try {
						errorDetail = await response.text();
					} catch {
						/* body not readable */
					}
				}

				throw new Error(
					`HTTP runtime '${this.kind}' at ${this.baseUrl} returned HTTP ${response.status}: ${response.statusText}${errorDetail ? ` — ${errorDetail}` : ""}`,
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
	 * Sends two shapes in the same envelope so the migration to the new
	 * canonical wire format is backward-compatible:
	 *
	 *   1. **Legacy keys** — `node.config` + `context.{request,response,vars,env}`.
	 *      Existing SDK HTTP servers (Rust, Python, Go HTTP, others) read
	 *      these keys today and keep working unchanged.
	 *
	 *   2. **New canonical keys** — `step` / `inputs` / `trigger` / `state` /
	 *      `workflow`. Same field names + structure as the gRPC proto so SDK
	 *      authors who adopt the new shape get a uniform mental model across
	 *      transports. The "inputs unwrapped at the wire layer" property
	 *      (FIXES.md #3) holds for both shapes.
	 *
	 * Data flow priority for the legacy `request.body`:
	 * 1. If the node has resolved inputs (from the blueprint Mapper), use
	 *    those as `request.body` so workflows that define explicit inputs
	 *    like `"chain": "js/ctx.response.data.chain"` keep working.
	 * 2. Otherwise, fall back to `ctx.response.data` (previous step output)
	 *    enabling zero-config chaining for SDK nodes that read body fields.
	 *
	 * The new `trigger.body` always reflects the actual trigger body
	 * (`ctx.request?.body`) — separated from inputs at the wire layer.
	 *
	 * Deprecation timeline: legacy keys will be removed in the next minor
	 * version once SDK HTTP servers have all adopted the new shape.
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
		const legacyRequestBody = resolvedInputs || (ctx.response?.data ?? {});

		// Unwrap the {inputs: {...}} wrapper that comes from @blokjs/helper StepNode.
		// SDK nodes expect config to contain the inputs directly (e.g. config.operation),
		// not wrapped as config.inputs.operation.
		const unwrappedConfig = resolvedInputs || (nodeConfig as Record<string, unknown>)?.inputs || nodeConfig || {};

		const stepInfo = (ctx as Record<string, unknown>)._stepInfo as
			| { name?: string; index?: number; total?: number; depth?: number }
			| undefined;

		const headers = ctx.request?.headers ?? {};
		const params = ctx.request?.params ?? {};
		const query = ctx.request?.query ?? {};
		const cookies = ctx.request?.cookies ?? {};
		const method = ctx.request?.method ?? "";
		const url = ctx.request?.url ?? "";
		const baseUrl = ctx.request?.baseUrl ?? "";

		return {
			// ===== Legacy keys (kept for one minor for backward compat) =====
			node: {
				name: node.node,
				type: node.type,
				version: "",
				config: unwrappedConfig,
			},
			context: {
				id: ctx.id,
				workflow_name: ctx.workflow_name,
				workflow_path: ctx.workflow_path,
				request: {
					body: legacyRequestBody,
					headers,
					params,
					query,
					method,
					url,
					cookies,
					baseUrl,
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

			// ===== New canonical keys (mirror the gRPC proto v1 schema) =====
			step: {
				name: stepInfo?.name ?? node.name,
				index: stepInfo?.index ?? 0,
				total: stepInfo?.total ?? 1,
				depth: stepInfo?.depth ?? 0,
			},
			inputs: unwrappedConfig,
			trigger: {
				body: ctx.request?.body ?? null,
				headers,
				params,
				query,
				cookies,
				method,
				url,
				baseUrl,
				triggerKind: "",
			},
			state: {
				previousOutput: ctx.response?.data ?? null,
				vars: ctx.vars ?? {},
				env: ctx.env ?? {},
			},
			workflow: {
				runId: ctx.id,
				name: ctx.workflow_name ?? "",
				path: ctx.workflow_path ?? "",
				version: "",
			},
		};
	}

	/**
	 * Check if the SDK container is healthy via GET /health
	 *
	 * If the health response includes a `version` field, it is stored
	 * in the RuntimeRegistry so that node-level runtime requirements
	 * can be validated at workflow load time.
	 */
	async checkHealth(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/health`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (response.ok) {
				const data = (await response.json()) as { status?: string; version?: string };
				const healthy = data.status === "healthy" || data.status === "ok";

				// Store reported runtime version for constraint validation
				if (healthy && data.version) {
					RuntimeRegistry.getInstance().setVersion(this.kind, data.version);
				}

				return healthy;
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
