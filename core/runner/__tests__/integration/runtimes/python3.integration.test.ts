/**
 * Python3 Runtime Adapter - Integration Tests
 *
 * Tests Python3 runtime via gRPC:
 * 1. ✅ Basic execution via gRPC
 * 2. ✅ Context propagation over gRPC (ctx.vars)
 * 3. ✅ Error handling across process boundary
 * 4. ✅ Sequential node execution
 * 5. ✅ Performance benchmarks (gRPC overhead)
 * 6. ✅ Concurrent executions
 *
 * Setup: Automatically starts/stops Python3 gRPC server on port 50051
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Context } from "@nanoservice-ts/shared";
import { RuntimeRegistry } from "../../../src/RuntimeRegistry";
import { Python3RuntimeAdapter } from "../../../src/adapters/Python3RuntimeAdapter";
import RunnerNode from "../../../src/RunnerNode";
import { startPython3Server, type GrpcServerHandle } from "../utils/grpc";

// Python3 gRPC server handle
let python3Server: GrpcServerHandle;

// Setup: Start Python3 server before tests
beforeAll(async () => {
	python3Server = await startPython3Server({
		port: 50051,
		startupTimeout: 10000, // 10 seconds for Python startup
		verbose: process.env.VERBOSE === "true",
	});
}, 15000); // 15 second timeout for server startup

// Teardown: Stop Python3 server after tests
afterAll(async () => {
	if (python3Server) {
		await python3Server.stop();
	}
});

describe("Python3RuntimeAdapter Integration Tests", () => {
	let registry: RuntimeRegistry;
	let adapter: Python3RuntimeAdapter;

	beforeAll(() => {
		registry = RuntimeRegistry.getInstance();
		if (!registry.has("python3")) {
			registry.register(new Python3RuntimeAdapter("localhost", 50051));
		}
		adapter = registry.get("python3");
	});

	/**
	 * Helper to create test context
	 */
	function createContext(vars: Record<string, unknown> = {}): Context {
		return {
			id: `test-${Date.now()}`,
			workflow_name: "test-workflow",
			workflow_path: "/test",
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

	/**
	 * Helper to create RunnerNode for Python3
	 */
	function createRunnerNode(nodeName: string, config: Record<string, unknown> = {}): RunnerNode {
		const node = new RunnerNode();
		node.node = nodeName;
		node.type = "runtime.python3";
		node.runtime = "python3";
		node.config = config;
		return node;
	}

	describe("Basic Execution", () => {
		it("should execute simple Python3 node via gRPC", async () => {
			// Arrange
			const ctx = createContext();
			const node = createRunnerNode("test-simple", {
				message: "Hello from integration test",
				count: 42,
			});

			// Act
			const startTime = performance.now();
			const result = await adapter.execute(node, ctx);
			const duration = performance.now() - startTime;

			// Assert
			expect(result.success).toBe(true);
			expect(result.errors).toBeNull();
			expect(result.data).toBeDefined();

			const data = result.data as any;
			expect(data.result).toContain("Python3 processed");
			expect(data.count).toBe(42);
			expect(result.metrics?.duration_ms).toBeGreaterThan(0);
			expect(duration).toBeLessThan(1000); // Should be < 1s with gRPC

			console.log(`✅ Python3 execution time: ${duration.toFixed(2)}ms`);
		});

		it("should handle Python3 node with minimal config", async () => {
			// Arrange
			const ctx = createContext();
			const node = createRunnerNode("test-simple", {
				message: "Minimal test",
			});

			// Act
			const result = await adapter.execute(node, ctx);

			// Assert
			expect(result.success).toBe(true);
			const data = result.data as any;
			expect(data.result).toContain("Python3 processed");
			expect(data.count).toBe(1); // Default value
		});
	});

	describe("Context Propagation", () => {
		it("should propagate ctx.vars to Python3 nodes", async () => {
			// Arrange
			const ctx = createContext({
				previous_message: "From test harness",
			});
			const node = createRunnerNode("test-context", {
				operation: "write",
			});

			// Act
			const result = await adapter.execute(node, ctx);

			// Assert
			expect(result.success).toBe(true);
			const data = result.data as any;
			expect(data.vars).toBeDefined();
			expect(data.vars.python_message).toBe("Hello from Python3");
			expect(data.vars.python_count).toBe(42);

			console.log("✅ Context variables propagated:", data.vars);
		});

		it("should read ctx.vars from previous operations in Python3", async () => {
			// Arrange
			const ctx = createContext({
				previous_message: "Test message from context",
			});
			const node = createRunnerNode("test-context", {
				operation: "read",
			});

			// Act
			const result = await adapter.execute(node, ctx);

			// Assert
			expect(result.success).toBe(true);
			const data = result.data as any;
			expect(data.result).toContain("Test message from context");

			console.log("✅ Context read successful:", data.result);
		});
	});

	describe("Error Handling", () => {
		it("should handle Python3 node errors correctly", async () => {
			// Arrange
			const ctx = createContext();
			const node = createRunnerNode("test-error", {
				should_fail: true,
				error_message: "Intentional test error",
			});

			// Act
			const result = await adapter.execute(node, ctx);

			// Assert
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();

			console.log("✅ Error handled correctly:", result.errors);
		});

		it("should handle gRPC connection errors gracefully", async () => {
			// Arrange - Create adapter with invalid port
			const badAdapter = new Python3RuntimeAdapter("localhost", 99999);
			const ctx = createContext();
			const node = createRunnerNode("test-simple", {
				message: "This should fail",
			});

			// Act
			const result = await badAdapter.execute(node, ctx);

			// Assert
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();

			console.log("✅ Connection error handled:", result.errors);
		});
	});

	describe("Sequential Execution", () => {
		it("should execute multiple Python3 nodes in sequence", async () => {
			// Arrange
			const ctx = createContext();
			const nodes = [
				createRunnerNode("test-simple", { message: "First node", count: 1 }),
				createRunnerNode("test-simple", { message: "Second node", count: 2 }),
				createRunnerNode("test-simple", { message: "Third node", count: 3 }),
			];

			// Act
			const results = [];
			for (const node of nodes) {
				const result = await adapter.execute(node, ctx);
				results.push(result);
			}

			// Assert
			expect(results).toHaveLength(3);
			for (const result of results) {
				expect(result.success).toBe(true);
			}

			console.log("✅ Sequential execution successful");
		});

		it("should maintain context across Python3 node sequence", async () => {
			// Arrange
			const ctx = createContext({
				previous_message: "Initial value",
			});

			// Act
			// First node writes to context
			const writeNode = createRunnerNode("test-context", {
				operation: "write",
			});
			const writeResult = await adapter.execute(writeNode, ctx);
			expect(writeResult.success).toBe(true);

			// Update ctx.vars with written values
			const writeData = writeResult.data as any;
			ctx.vars = { ...ctx.vars, ...writeData.vars };

			// Second node reads from context
			const readNode = createRunnerNode("test-context", {
				operation: "read",
			});
			const readResult = await adapter.execute(readNode, ctx);

			// Assert
			expect(readResult.success).toBe(true);
			const readData = readResult.data as any;
			expect(readData.vars.python_message).toBe("Hello from Python3");
			expect(readData.vars.python_count).toBe(42);

			console.log("✅ Context maintained across sequence");
		});
	});

	describe("Performance Benchmarks", () => {
		it("should execute Python3 node with acceptable gRPC overhead", async () => {
			// Arrange
			const ctx = createContext();
			const node = createRunnerNode("test-simple", {
				message: "Performance test",
			});

			// Act
			const startTime = performance.now();
			const result = await adapter.execute(node, ctx);
			const duration = performance.now() - startTime;

			// Assert
			expect(result.success).toBe(true);
			expect(duration).toBeGreaterThan(0);
			expect(duration).toBeLessThan(100); // gRPC should be < 100ms

			console.log(`\n📊 Python3 Execution Time: ${duration.toFixed(2)}ms`);
		});

		it("should benchmark Python3 node execution performance", async () => {
			// Arrange
			const iterations = 10; // Fewer iterations due to gRPC overhead
			const ctx = createContext();
			const node = createRunnerNode("test-simple", {
				message: "Benchmark test",
			});

			// Act
			const durations: number[] = [];
			for (let i = 0; i < iterations; i++) {
				const startTime = performance.now();
				const result = await adapter.execute(node, ctx);
				const duration = performance.now() - startTime;
				durations.push(duration);
				expect(result.success).toBe(true);
			}

			// Calculate stats
			const total = durations.reduce((sum, d) => sum + d, 0);
			const avg = total / iterations;
			const min = Math.min(...durations);
			const max = Math.max(...durations);

			// Assert
			expect(avg).toBeGreaterThan(0);
			expect(avg).toBeLessThan(100); // gRPC avg < 100ms

			// Log results
			console.log("\n📊 Python3 Performance Benchmark:");
			console.log(`   Total: ${total.toFixed(2)}ms`);
			console.log(`   Average: ${avg.toFixed(2)}ms`);
			console.log(`   Min: ${min.toFixed(2)}ms`);
			console.log(`   Max: ${max.toFixed(2)}ms`);
			console.log(`   Iterations: ${iterations}`);
		});

		it("should handle concurrent Python3 node executions", async () => {
			// Arrange
			const concurrentCount = 5;
			const ctx = createContext();
			const promises = Array.from({ length: concurrentCount }, (_, i) =>
				adapter.execute(
					createRunnerNode("test-simple", {
						message: `Concurrent test ${i + 1}`,
						count: i + 1,
					}),
					ctx,
				),
			);

			// Act
			const startTime = performance.now();
			const results = await Promise.all(promises);
			const duration = performance.now() - startTime;

			// Assert
			expect(results).toHaveLength(concurrentCount);
			for (const result of results) {
				expect(result.success).toBe(true);
			}

			console.log("\n📊 Concurrent Python3 Executions:");
			console.log(`   Count: ${concurrentCount}`);
			console.log(`   Total Time: ${duration.toFixed(2)}ms`);
			console.log(`   Avg per request: ${(duration / concurrentCount).toFixed(2)}ms`);
		});
	});
});
