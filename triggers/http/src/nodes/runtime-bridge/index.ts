import { defineNode, type JsonLikeObject } from "@nanoservice-ts/runner";
import type { Context } from "@nanoservice-ts/shared";
import { z } from "zod";

/**
 * RuntimeBridge node — forwards execution to an external SDK container via HTTP.
 *
 * Constructs an ExecutionRequest from the current ctx.response.data,
 * POSTs it to the SDK container's /execute endpoint, and returns
 * the ExecutionResult.data.
 */
export default defineNode({
	name: "runtime-bridge",
	description:
		"Forwards execution to an external SDK container via HTTP",

	input: z.object({
		url: z.string(),
		node_name: z.string(),
	}),

	output: z.record(z.unknown()),

	async execute(ctx: Context, input) {
		// Get the chain data from previous step's output
		const chainData = (ctx.response?.data as JsonLikeObject) || {};

		// Construct the ExecutionRequest per the SDK HTTP contract
		const executionRequest = {
			node: {
				name: input.node_name,
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
		const fetchResponse = await fetch(`${input.url}/execute`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(executionRequest),
		});

		if (!fetchResponse.ok) {
			throw new Error(
				`SDK container at ${input.url} returned HTTP ${fetchResponse.status}: ${fetchResponse.statusText}`,
			);
		}

		const result = (await fetchResponse.json()) as {
			success: boolean;
			data: JsonLikeObject;
			errors?: unknown;
		};

		if (!result.success) {
			throw new Error(
				`SDK node "${input.node_name}" at ${input.url} failed: ${JSON.stringify(result.errors)}`,
			);
		}

		return result.data as Record<string, unknown>;
	},
});
