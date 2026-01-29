import {
	type INanoServiceResponse,
	type JsonLikeObject,
	NanoService,
	NanoServiceResponse,
} from "@nanoservice-ts/runner";
import { type Context, GlobalError } from "@nanoservice-ts/shared";

type InputType = {
	url: string;
	node_name: string;
};

/**
 * RuntimeBridge node — forwards execution to an external SDK container via HTTP.
 *
 * Constructs an ExecutionRequest from the current ctx.response.data,
 * POSTs it to the SDK container's /execute endpoint, and returns
 * the ExecutionResult.data.
 */
export default class RuntimeBridge extends NanoService<InputType> {
	constructor() {
		super();
		this.inputSchema = {
			$schema: "http://json-schema.org/draft-04/schema#",
			type: "object",
			properties: {
				url: { type: "string" },
				node_name: { type: "string" },
			},
			required: ["url", "node_name"],
		};
	}

	async handle(ctx: Context, inputs: InputType): Promise<INanoServiceResponse> {
		const response = new NanoServiceResponse();

		try {
			// Get the chain data from previous step's output
			const chainData = (ctx.response?.data as JsonLikeObject) || {};

			// Construct the ExecutionRequest per the SDK HTTP contract
			const executionRequest = {
				node: {
					name: inputs.node_name,
					type: "default",
					config: {},
				},
				context: {
					id: ctx.id || "cross-runtime-chain",
					workflow_name: ctx.workflow_name || "cross-runtime-chain",
					workflow_path: ctx.workflow_path || "/cross-runtime-chain",
					request: {
						body: chainData,
						headers: {},
						params: {},
						query: {},
						method: "POST",
						url: "/execute",
						cookies: {},
						baseUrl: "",
					},
					response: {
						data: null,
						contentType: "application/json",
						success: true,
						error: null,
					},
					vars: {},
					env: {},
				},
			};

			// POST to the SDK container
			const fetchResponse = await fetch(`${inputs.url}/execute`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(executionRequest),
			});

			if (!fetchResponse.ok) {
				throw new Error(
					`SDK container at ${inputs.url} returned HTTP ${fetchResponse.status}: ${fetchResponse.statusText}`,
				);
			}

			const result = (await fetchResponse.json()) as {
				success: boolean;
				data: JsonLikeObject;
				errors?: unknown;
			};

			if (!result.success) {
				throw new Error(
					`SDK node "${inputs.node_name}" at ${inputs.url} failed: ${JSON.stringify(result.errors)}`,
				);
			}

			response.setSuccess(result.data);
		} catch (error: unknown) {
			const nodeError = new GlobalError((error as Error).message);
			nodeError.setCode(500);
			response.setError(nodeError);
		}

		return response;
	}
}
