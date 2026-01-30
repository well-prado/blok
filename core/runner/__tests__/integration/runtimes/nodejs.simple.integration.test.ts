/**
 * NodeJS Runtime Adapter - Simple Integration Test
 */

import type { Context } from "@nanoservice-ts/shared";
import { beforeAll, describe, expect, it } from "vitest";
import NanoService from "../../../src/NanoService";
import NanoServiceResponse, { type INanoServiceResponse } from "../../../src/NanoServiceResponse";
import { RuntimeRegistry } from "../../../src/RuntimeRegistry";
import { NodeJsRuntimeAdapter } from "../../../src/adapters/NodeJsRuntimeAdapter";

// Simple test node
class SimpleNode extends NanoService<{ input: string }> {
	constructor() {
		super();
		this.name = "simple-node";
		this.inputSchema = {
			type: "object",
			properties: {
				input: { type: "string" },
			},
		};
		this.outputSchema = {
			type: "object",
			properties: {
				output: { type: "string" },
			},
		};
	}

	async handle(ctx: Context, inputs: { input: string }): Promise<INanoServiceResponse> {
		const response = new NanoServiceResponse();
		response.setSuccess({ output: `Processed: ${inputs.input}` });
		return response;
	}
}

describe("NodeJS Runtime Adapter - Simple Test", () => {
	let registry: RuntimeRegistry;

	beforeAll(() => {
		registry = RuntimeRegistry.getInstance();
		if (!registry.has("nodejs")) {
			registry.register(new NodeJsRuntimeAdapter());
		}
	});

	it("should execute a node successfully", async () => {
		const adapter = registry.get("nodejs");
		const node = new SimpleNode();

		const ctx: Context = {
			id: "test",
			workflow_name: "test",
			workflow_path: "/test",
			config: {
				"simple-node": {
					inputs: {
						input: "Hello",
					},
				},
			},
			request: { body: {} },
			response: { data: "", contentType: "", success: true, error: null },
			error: { message: [] },
			vars: {},
			logger: console as any,
			eventLogger: null,
			_PRIVATE_: null,
			env: process.env,
		};

		const result = await adapter.execute(node as any, ctx);

		console.log("Result:", JSON.stringify(result, null, 2));

		expect(result.success).toBe(true);
		expect((result.data as any).data).toEqual({ output: "Processed: Hello" });
	});
});
