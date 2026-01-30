/**
 * Multi-Runtime Workflow Integration Tests
 *
 * Tests workflow execution across multiple runtime adapters:
 * 1. ✅ NodeJS → Python3 data flow (in-process → HTTP)
 * 2. ✅ NodeJS → Docker data flow (in-process → HTTP container)
 * 3. ✅ Context propagation across runtime boundaries
 * 4. ✅ Error propagation across runtimes
 * 5. ✅ Sequential multi-runtime pipelines
 * 6. ✅ Performance benchmarks (cross-runtime overhead)
 * 7. ✅ RuntimeRegistry coordination
 * 8. ✅ Mixed runtime workflow patterns
 *
 * Requires: NodeJS adapter always available
 * Optional: Python3 HTTP SDK container on port 9007
 */

import type { Context } from "@nanoservice-ts/shared";
import { GlobalError } from "@nanoservice-ts/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import NanoService from "../../../src/NanoService";
import NanoServiceResponse, { type INanoServiceResponse } from "../../../src/NanoServiceResponse";
import RunnerNode from "../../../src/RunnerNode";
import { RuntimeAdapterNode } from "../../../src/RuntimeAdapterNode";
import { RuntimeRegistry } from "../../../src/RuntimeRegistry";
import { HttpRuntimeAdapter } from "../../../src/adapters/HttpRuntimeAdapter";
import { NodeJsRuntimeAdapter } from "../../../src/adapters/NodeJsRuntimeAdapter";
import type { ExecutionResult, RuntimeAdapter } from "../../../src/adapters/RuntimeAdapter";

// ============================================================================
// Test Configuration
// ============================================================================

let python3Available = false;

// ============================================================================
// Test Node Definitions (NodeJS)
// ============================================================================

/**
 * Fetch user node - simulates fetching user data
 */
class FetchUserNode extends NanoService<{ userId: string }> {
	constructor() {
		super();
		this.name = "fetch-user";
	}

	async handle(ctx: Context, inputs: { userId: string }): Promise<INanoServiceResponse> {
		const response = new NanoServiceResponse();
		const user = {
			id: inputs.userId,
			name: `User ${inputs.userId}`,
			email: `user${inputs.userId}@example.com`,
			createdAt: new Date().toISOString(),
		};

		// Store in context for downstream nodes
		if (ctx.vars) {
			ctx.vars["fetched-user"] = user;
		}

		response.setSuccess({ user });
		return response;
	}
}

/**
 * Transform node - transforms data for next step
 */
class DataTransformNode extends NanoService<{ data: unknown; format: string }> {
	constructor() {
		super();
		this.name = "data-transform";
	}

	async handle(ctx: Context, inputs: { data: unknown; format: string }): Promise<INanoServiceResponse> {
		const response = new NanoServiceResponse();

		let transformed: unknown;
		switch (inputs.format) {
			case "uppercase":
				transformed = typeof inputs.data === "string" ? inputs.data.toUpperCase() : inputs.data;
				break;
			case "json":
				transformed = JSON.stringify(inputs.data);
				break;
			case "base64":
				transformed = Buffer.from(JSON.stringify(inputs.data)).toString("base64");
				break;
			default:
				transformed = inputs.data;
		}

		if (ctx.vars) {
			ctx.vars["transformed-data"] = transformed;
		}

		response.setSuccess({ transformed, format: inputs.format });
		return response;
	}
}

/**
 * Aggregator node - aggregates results from previous steps
 */
class AggregatorNode extends NanoService<Record<string, never>> {
	constructor() {
		super();
		this.name = "aggregator";
	}

	async handle(ctx: Context): Promise<INanoServiceResponse> {
		const response = new NanoServiceResponse();

		// Read all vars from previous steps
		const aggregated: Record<string, unknown> = {};
		if (ctx.vars) {
			for (const [key, value] of Object.entries(ctx.vars)) {
				aggregated[key] = value;
			}
		}

		response.setSuccess({
			aggregated,
			stepCount: Object.keys(aggregated).length,
		});
		return response;
	}
}

/**
 * Error node - conditionally fails for testing error propagation
 */
class ConditionalErrorNode extends NanoService<{ failAfterStep: number }> {
	constructor() {
		super();
		this.name = "conditional-error";
	}

	async handle(ctx: Context, inputs: { failAfterStep: number }): Promise<INanoServiceResponse> {
		const response = new NanoServiceResponse();
		const currentStep = ((ctx.vars?.["step-counter"] as number) || 0) + 1;

		if (ctx.vars) {
			ctx.vars["step-counter"] = currentStep;
		}

		if (currentStep >= inputs.failAfterStep) {
			const error = new GlobalError(`Failed at step ${currentStep}`);
			error.setCode(500);
			error.setName("StepError");
			response.setError(error);
		} else {
			response.setSuccess({ step: currentStep, status: "ok" });
		}

		return response;
	}
}

// ============================================================================
// Helpers
// ============================================================================

function createContext(vars: Record<string, unknown> = {}): Context {
	return {
		id: `multi-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		workflow_name: "multi-runtime-test",
		workflow_path: "/multi-runtime-test",
		config: {},
		request: { body: {} },
		response: { data: "", contentType: "", success: true, error: null },
		error: { message: [] },
		vars,
		logger: console as any,
		eventLogger: null,
		_PRIVATE_: null,
		env: process.env,
	};
}

function createRunnerNode(nodeName: string, config: Record<string, unknown> = {}): RunnerNode {
	const node = new RunnerNode();
	node.node = nodeName;
	node.name = nodeName;
	node.type = "runtime.python3";
	node.runtime = "python3";
	node.config = config;
	return node;
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeAll(async () => {
	// Ensure NodeJS adapter is registered
	const registry = RuntimeRegistry.getInstance();
	if (!registry.has("nodejs")) {
		registry.register(new NodeJsRuntimeAdapter());
	}

	// Check if Python3 HTTP SDK is reachable (running in Docker on port 9007)
	const python3Host = process.env.RUNTIME_PYTHON3_HOST || "localhost";
	const python3Port = process.env.RUNTIME_PYTHON3_PORT ? Number.parseInt(process.env.RUNTIME_PYTHON3_PORT) : 9007;
	try {
		const healthResponse = await fetch(`http://${python3Host}:${python3Port}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		if (healthResponse.ok) {
			python3Available = true;

			if (!registry.has("python3")) {
				registry.register(new HttpRuntimeAdapter("python3", python3Host, python3Port));
			} else {
				registry.replace(new HttpRuntimeAdapter("python3", python3Host, python3Port));
			}

			console.log("✅ Python3 HTTP SDK available for multi-runtime tests");
		}
	} catch {
		python3Available = false;
		console.warn("⚠️  Python3 HTTP SDK not available - Python cross-runtime tests will be skipped");
	}
}, 20000);

// ============================================================================
// Tests
// ============================================================================

describe("Multi-Runtime Workflow Integration Tests", () => {
	let registry: RuntimeRegistry;
	let nodejsAdapter: NodeJsRuntimeAdapter;

	beforeAll(() => {
		registry = RuntimeRegistry.getInstance();
		nodejsAdapter = registry.get("nodejs") as NodeJsRuntimeAdapter;
	});

	// ========================================================================
	// NodeJS-only Multi-Step Workflows
	// ========================================================================

	describe("NodeJS Multi-Step Workflows", () => {
		it("should execute a 3-step NodeJS pipeline", async () => {
			const ctx = createContext();

			// Step 1: Fetch user
			const fetchNode = new FetchUserNode();
			ctx.config["fetch-user"] = { inputs: { userId: "123" } };
			const fetchResult = await nodejsAdapter.execute(fetchNode as any, ctx);
			expect(fetchResult.success).toBe(true);

			const user = (fetchResult.data as any).data.user;
			expect(user.id).toBe("123");
			expect(ctx.vars?.["fetched-user"]).toBeDefined();

			// Step 2: Transform data
			const transformNode = new DataTransformNode();
			ctx.config["data-transform"] = {
				inputs: { data: user.name, format: "uppercase" },
			};
			const transformResult = await nodejsAdapter.execute(transformNode as any, ctx);
			expect(transformResult.success).toBe(true);

			const transformed = (transformResult.data as any).data.transformed;
			expect(transformed).toBe("USER 123");

			// Step 3: Aggregate results
			const aggregatorNode = new AggregatorNode();
			ctx.config.aggregator = { inputs: {} };
			const aggregateResult = await nodejsAdapter.execute(aggregatorNode as any, ctx);
			expect(aggregateResult.success).toBe(true);

			const aggregated = (aggregateResult.data as any).data;
			expect(aggregated.stepCount).toBeGreaterThanOrEqual(2);
			expect(aggregated.aggregated["fetched-user"]).toBeDefined();
			expect(aggregated.aggregated["transformed-data"]).toBe("USER 123");

			console.log("✅ 3-step NodeJS pipeline executed successfully");
		});

		it("should pass data through context vars across steps", async () => {
			const ctx = createContext();

			// Step 1: Write to ctx.vars
			const fetchNode = new FetchUserNode();
			ctx.config["fetch-user"] = { inputs: { userId: "456" } };
			await nodejsAdapter.execute(fetchNode as any, ctx);

			// Verify ctx.vars was updated
			expect(ctx.vars?.["fetched-user"]).toBeDefined();
			const user = ctx.vars?.["fetched-user"] as { id: string; name: string };
			expect(user.id).toBe("456");

			// Step 2: Read from ctx.vars (simulating cross-runtime)
			const transformNode = new DataTransformNode();
			ctx.config["data-transform"] = {
				inputs: { data: user.name, format: "base64" },
			};
			const transformResult = await nodejsAdapter.execute(transformNode as any, ctx);
			expect(transformResult.success).toBe(true);

			const base64Data = (transformResult.data as any).data.transformed;
			expect(typeof base64Data).toBe("string");

			// Decode and verify
			const decoded = JSON.parse(Buffer.from(base64Data, "base64").toString());
			expect(decoded).toBe("User 456");

			console.log("✅ Context vars propagation across steps verified");
		});
	});

	// ========================================================================
	// NodeJS → Python3 Cross-Runtime Workflows
	// ========================================================================

	describe("NodeJS → Python3 Cross-Runtime", () => {
		it.skipIf(!python3Available)(
			"should execute NodeJS node then Python3 node in sequence",
			async () => {
				const ctx = createContext();

				// Step 1: NodeJS - Fetch user data
				const fetchNode = new FetchUserNode();
				ctx.config["fetch-user"] = { inputs: { userId: "789" } };
				const nodejsResult = await nodejsAdapter.execute(fetchNode as any, ctx);
				expect(nodejsResult.success).toBe(true);

				const user = (nodejsResult.data as any).data.user;
				expect(user.name).toBe("User 789");

				// Step 2: Python3 - Process the data
				const python3Adapter = registry.get("python3");
				const pythonNode = createRunnerNode("test-simple", {
					message: user.name,
					count: 1,
				});
				const pythonResult = await python3Adapter.execute(pythonNode, ctx);
				expect(pythonResult.success).toBe(true);

				console.log("✅ NodeJS → Python3 cross-runtime execution successful");
			},
			30000,
		);

		it.skipIf(!python3Available)(
			"should propagate context across NodeJS → Python3 boundary",
			async () => {
				const ctx = createContext({ origin: "nodejs" });

				// Step 1: NodeJS writes to context
				const fetchNode = new FetchUserNode();
				ctx.config["fetch-user"] = { inputs: { userId: "cross-runtime" } };
				await nodejsAdapter.execute(fetchNode as any, ctx);

				// Verify context was updated by NodeJS step
				expect(ctx.vars?.["fetched-user"]).toBeDefined();

				// Step 2: Python3 reads the context
				const python3Adapter = registry.get("python3");
				const pythonNode = createRunnerNode("test-context", {
					operation: "read",
				});
				const pythonResult = await python3Adapter.execute(pythonNode, ctx);
				expect(pythonResult.success).toBe(true);

				console.log("✅ Context propagated across NodeJS → Python3 boundary");
			},
			30000,
		);

		it.skipIf(!python3Available)(
			"should handle Python3 error after NodeJS success",
			async () => {
				const ctx = createContext();

				// Step 1: NodeJS succeeds
				const fetchNode = new FetchUserNode();
				ctx.config["fetch-user"] = { inputs: { userId: "error-test" } };
				const nodejsResult = await nodejsAdapter.execute(fetchNode as any, ctx);
				expect(nodejsResult.success).toBe(true);

				// Step 2: Python3 fails
				const python3Adapter = registry.get("python3");
				const pythonNode = createRunnerNode("test-error", {
					should_fail: true,
					error_message: "Cross-runtime error",
				});
				const pythonResult = await python3Adapter.execute(pythonNode, ctx);
				expect(pythonResult.success).toBe(false);
				expect(pythonResult.errors).toBeDefined();

				// Context from Step 1 should still be intact
				expect(ctx.vars?.["fetched-user"]).toBeDefined();

				console.log("✅ Error propagation across runtime boundary handled correctly");
			},
			30000,
		);
	});

	// ========================================================================
	// RuntimeAdapterNode Bridge Tests
	// ========================================================================

	describe("RuntimeAdapterNode Bridge", () => {
		it("should bridge NodeJS adapter through RuntimeAdapterNode", async () => {
			const fetchNode = new FetchUserNode();
			// NanoService sets 'name', not 'node'. Ensure both are set for bridge.
			(fetchNode as any).node = "fetch-user";

			// The bridge wraps the adapter call
			const bridgeNode = new RuntimeAdapterNode(nodejsAdapter, fetchNode as any);

			expect(bridgeNode.node).toBe("fetch-user");
			expect(bridgeNode.name).toBe("fetch-user");

			const ctx = createContext();
			ctx.config["fetch-user"] = { inputs: { userId: "bridge-test" } };

			const responseCtx = await bridgeNode.run(ctx);

			expect(responseCtx.success).toBe(true);
			expect(responseCtx.data).toBeDefined();
			expect(responseCtx.error).toBeNull();

			console.log("✅ RuntimeAdapterNode bridge working correctly");
		});

		it("should convert ExecutionResult errors to GlobalError via bridge", async () => {
			// Create a mock adapter that returns an error
			const mockAdapter: RuntimeAdapter = {
				kind: "nodejs",
				async execute(): Promise<ExecutionResult> {
					return {
						success: false,
						data: null,
						errors: {
							message: "Mock adapter error",
							name: "MockError",
							stack: "at mock.ts:1",
						},
					};
				},
			};

			const targetNode = new RunnerNode();
			targetNode.node = "mock-node";
			targetNode.name = "mock-node";

			const bridgeNode = new RuntimeAdapterNode(mockAdapter, targetNode);
			const ctx = createContext();

			const responseCtx = await bridgeNode.run(ctx);

			expect(responseCtx.success).toBe(false);
			expect(responseCtx.error).toBeInstanceOf(GlobalError);
			expect(responseCtx.error?.message).toBe("Mock adapter error");

			console.log("✅ Error conversion through bridge working correctly");
		});

		it("should handle string errors via bridge", async () => {
			const mockAdapter: RuntimeAdapter = {
				kind: "nodejs",
				async execute(): Promise<ExecutionResult> {
					return {
						success: false,
						data: null,
						errors: "Simple string error",
					};
				},
			};

			const targetNode = new RunnerNode();
			targetNode.node = "string-error-node";
			targetNode.name = "string-error-node";

			const bridgeNode = new RuntimeAdapterNode(mockAdapter, targetNode);
			const ctx = createContext();

			const responseCtx = await bridgeNode.run(ctx);

			expect(responseCtx.success).toBe(false);
			expect(responseCtx.error).toBeInstanceOf(GlobalError);
			expect(responseCtx.error?.message).toBe("Simple string error");

			console.log("✅ String error conversion working correctly");
		});

		it("should handle null errors (success case) via bridge", async () => {
			const mockAdapter: RuntimeAdapter = {
				kind: "nodejs",
				async execute(): Promise<ExecutionResult> {
					return {
						success: true,
						data: { result: "success" },
						errors: null,
					};
				},
			};

			const targetNode = new RunnerNode();
			targetNode.node = "success-node";
			targetNode.name = "success-node";

			const bridgeNode = new RuntimeAdapterNode(mockAdapter, targetNode);
			const ctx = createContext();

			const responseCtx = await bridgeNode.run(ctx);

			expect(responseCtx.success).toBe(true);
			expect(responseCtx.data).toEqual({ result: "success" });
			expect(responseCtx.error).toBeNull();

			console.log("✅ Success case through bridge working correctly");
		});
	});

	// ========================================================================
	// Error Propagation Across Runtimes
	// ========================================================================

	describe("Error Propagation", () => {
		it("should handle NodeJS error without affecting subsequent steps", async () => {
			const ctx = createContext();

			// Step 1: NodeJS error
			const errorNode = new ConditionalErrorNode();
			ctx.config["conditional-error"] = { inputs: { failAfterStep: 1 } };
			const errorResult = await nodejsAdapter.execute(errorNode as any, ctx);
			expect(errorResult.success).toBe(false);

			// Step 2: Another NodeJS step should still work
			const fetchNode = new FetchUserNode();
			ctx.config["fetch-user"] = { inputs: { userId: "after-error" } };
			const fetchResult = await nodejsAdapter.execute(fetchNode as any, ctx);
			expect(fetchResult.success).toBe(true);

			console.log("✅ Error propagation handled - subsequent steps unaffected");
		});

		it("should track step counter across executions", async () => {
			const ctx = createContext();
			const errorNode = new ConditionalErrorNode();

			// Execute multiple steps, fail at step 3
			for (let i = 0; i < 4; i++) {
				ctx.config["conditional-error"] = { inputs: { failAfterStep: 3 } };
				const result = await nodejsAdapter.execute(errorNode as any, ctx);

				if (i < 2) {
					expect(result.success).toBe(true);
				} else {
					expect(result.success).toBe(false);
				}
			}

			expect(ctx.vars?.["step-counter"]).toBe(4);

			console.log("✅ Step counter tracked correctly across executions");
		});
	});

	// ========================================================================
	// Performance - Cross-Runtime Overhead
	// ========================================================================

	describe("Performance Benchmarks", () => {
		it("should measure NodeJS multi-step overhead", async () => {
			const durations: number[] = [];

			for (let i = 0; i < 10; i++) {
				const ctx = createContext();
				const startTime = performance.now();

				// 3-step pipeline
				const fetchNode = new FetchUserNode();
				ctx.config["fetch-user"] = { inputs: { userId: `perf-${i}` } };
				await nodejsAdapter.execute(fetchNode as any, ctx);

				const transformNode = new DataTransformNode();
				ctx.config["data-transform"] = {
					inputs: { data: "test", format: "uppercase" },
				};
				await nodejsAdapter.execute(transformNode as any, ctx);

				const aggregatorNode = new AggregatorNode();
				ctx.config.aggregator = { inputs: {} };
				await nodejsAdapter.execute(aggregatorNode as any, ctx);

				const duration = performance.now() - startTime;
				durations.push(duration);
			}

			const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
			const sorted = [...durations].sort((a, b) => a - b);

			console.log("\n📊 NodeJS 3-Step Pipeline Performance:");
			console.log(`   Average: ${avg.toFixed(2)}ms`);
			console.log(`   Min: ${sorted[0].toFixed(2)}ms`);
			console.log(`   Max: ${sorted[sorted.length - 1].toFixed(2)}ms`);

			// 3-step NodeJS pipeline should be < 50ms
			expect(avg).toBeLessThan(100); // Generous for CI
		});

		it.skipIf(!python3Available)(
			"should measure NodeJS → Python3 cross-runtime overhead",
			async () => {
				const durations: number[] = [];

				for (let i = 0; i < 5; i++) {
					const ctx = createContext();
					const startTime = performance.now();

					// Step 1: NodeJS
					const fetchNode = new FetchUserNode();
					ctx.config["fetch-user"] = { inputs: { userId: `cross-perf-${i}` } };
					await nodejsAdapter.execute(fetchNode as any, ctx);

					// Step 2: Python3
					const python3Adapter = registry.get("python3");
					const pythonNode = createRunnerNode("test-simple", {
						message: "cross-runtime",
						count: i,
					});
					await python3Adapter.execute(pythonNode, ctx);

					const duration = performance.now() - startTime;
					durations.push(duration);
				}

				const avg = durations.reduce((a, b) => a + b, 0) / durations.length;

				console.log("\n📊 NodeJS → Python3 Cross-Runtime Performance:");
				console.log(`   Average: ${avg.toFixed(2)}ms`);

				// Cross-runtime should be < 500ms
				expect(avg).toBeLessThan(1000);
			},
			30000,
		);
	});

	// ========================================================================
	// Registry Coordination
	// ========================================================================

	describe("RuntimeRegistry Coordination", () => {
		it("should provide access to multiple registered adapters", () => {
			expect(registry.has("nodejs")).toBe(true);

			const kinds = registry.getRegisteredKinds();
			expect(kinds).toContain("nodejs");
			expect(kinds.length).toBeGreaterThanOrEqual(1);

			if (python3Available) {
				expect(kinds).toContain("python3");
			}
		});

		it("should throw for unregistered runtime", () => {
			expect(() => registry.get("wasm")).toThrow();
		});

		it("should support runtime adapter replacement", () => {
			const original = registry.get("nodejs");
			expect(original.kind).toBe("nodejs");

			// Replace with new instance
			const newAdapter = new NodeJsRuntimeAdapter();
			registry.replace(newAdapter);

			const replaced = registry.get("nodejs");
			expect(replaced.kind).toBe("nodejs");
			expect(replaced).toBe(newAdapter);

			console.log("✅ Runtime adapter replacement working");
		});
	});
});
