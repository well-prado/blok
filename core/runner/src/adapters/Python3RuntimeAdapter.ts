import type { Context } from "@nanoservice-ts/shared";
import type RunnerNode from "../RunnerNode";
import NodeGrpcNativeClient from "../NodeGrpcNativeClient";
import type { NodeRequest, NodeResponse } from "../NodeGrpcClient";
import type { ExecutionResult, RuntimeAdapter } from "./RuntimeAdapter";

/**
 * Python3RuntimeAdapter executes Python nodes via gRPC
 *
 * This adapter communicates with a Python gRPC server that hosts Python nodes.
 * It maintains the existing gRPC protocol and is fully backward compatible
 * with existing Python nodes.
 */
export class Python3RuntimeAdapter implements RuntimeAdapter {
	public readonly kind = "python3";
	private host: string;
	private port: number;

	constructor(host?: string, port?: number) {
		this.host = host || process.env.RUNTIME_PYTHON3_HOST || "localhost";
		this.port = port || (process.env.RUNTIME_PYTHON3_PORT ? Number.parseInt(process.env.RUNTIME_PYTHON3_PORT) : 50051);
	}

	/**
	 * Execute a Python node via gRPC
	 *
	 * @param node - The node to execute (contains node path and name)
	 * @param ctx - The workflow execution context
	 * @returns Promise that resolves to ExecutionResult
	 */
	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();

		try {
			// Get node config from node.config or ctx.config[nodeName] or default to empty object
			const nodeConfig = node.config || (ctx.config as Record<string, unknown>)?.[node.name] as Record<string, unknown> || {};
			const context = this.createContext(ctx, nodeConfig);
			const nodeRequest = this.createNodeRequest(node, context);
			const client = new NodeGrpcNativeClient(this.host, this.port);
			const response = await client.call(nodeRequest);
			const parsedResponse = this.parseNodeResponse(response) as Record<string, unknown>;

			const duration_ms = performance.now() - startTime;

			// Check if the Python node reported an error
			const nodeSuccess = parsedResponse.success !== false;
			const nodeErrors = parsedResponse.error || null;

			return {
				success: nodeSuccess,
				data: parsedResponse,
				errors: nodeErrors,
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
	 * Parse the gRPC response from Python runtime
	 */
	private parseNodeResponse(response: NodeResponse): unknown {
		const decodedResponse = Buffer.from(response.Message, "base64").toString("utf-8");
		return JSON.parse(decodedResponse);
	}

	/**
	 * Create the gRPC request to send to Python runtime
	 */
	private createNodeRequest(node: RunnerNode, context: unknown): NodeRequest {
		const base64Context = Buffer.from(JSON.stringify(context)).toString("base64");
		return {
			Name: node.node,
			Message: base64Context,
			Encoding: "BASE64",
			Type: "JSON",
		} as NodeRequest;
	}

	/**
	 * Create the context object to send to Python runtime
	 */
	private createContext(ctx: Context, config: Record<string, unknown>): unknown {
		return {
			request: {
				body: ctx.request.body,
				headers: ctx.request.headers,
				params: ctx.request.params,
				query: ctx.request.query,
				method: ctx.request.method,
				url: ctx.request.url,
				cookies: ctx.request.cookies,
				baseUrl: ctx.request.baseUrl,
			},
			response: ctx.response,
			vars: ctx.vars,
			env: ctx.env,
			config: config,
		};
	}
}
