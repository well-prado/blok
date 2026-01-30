/**
 * Unit Tests for BunRuntimeAdapter
 * Tests in-process and subprocess Bun node execution
 */

import type { Context } from "@blok/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertExecutionTimeWithinRange,
	assertValidExecutionResult,
	createMockContext,
	measureExecutionTime,
} from "../../../test/helpers/test-utils";
import type RunnerNode from "../../RunnerNode";
import { BunRuntimeAdapter } from "../BunRuntimeAdapter";

describe("BunRuntimeAdapter", () => {
	let adapter: BunRuntimeAdapter;

	beforeEach(() => {
		adapter = new BunRuntimeAdapter();
	});

	describe("Adapter Properties", () => {
		it("should have bun as kind", () => {
			expect(adapter.kind).toBe("bun");
		});

		it("should have execute method", () => {
			expect(adapter.execute).toBeDefined();
			expect(typeof adapter.execute).toBe("function");
		});
	});

	describe("execute() - In-Process Mode (simulated)", () => {
		// When running in Node.js test environment, we test the in-process path
		// by mocking the Bun detection

		it("should execute node successfully and return ExecutionResult", async () => {
			// Force in-process mode by setting isBunRuntime
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = createMockNodeWithRun({
				success: true,
				data: { result: "bun test success" },
				error: null,
			});

			const result = await adapter.execute(mockNode, mockContext);

			assertValidExecutionResult(result);
			expect(result.success).toBe(true);
			expect(result.data).toEqual({ result: "bun test success" });
			expect(result.errors).toBeNull();
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});

		it("should execute node with null data", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = createMockNodeWithRun({
				success: true,
				data: null,
				error: null,
			});

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toBeNull();
		});

		it("should pass context to node run method", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext({
				id: "bun-test-id",
				workflow_name: "bun-workflow",
			});

			let capturedContext: Context | null = null;
			const mockNode = {
				run: vi.fn(async (ctx: Context) => {
					capturedContext = ctx;
					return { success: true, data: {}, error: null };
				}),
			} as unknown as RunnerNode;

			await adapter.execute(mockNode, mockContext);

			expect(mockNode.run).toHaveBeenCalledWith(mockContext);
			expect(capturedContext).toBe(mockContext);
			expect(capturedContext?.id).toBe("bun-test-id");
		});

		it("should handle node execution errors", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = createMockNodeWithRun({
				success: false,
				data: null,
				error: { message: "Bun execution failed", code: 500 },
			});

			const result = await adapter.execute(mockNode, mockContext);

			assertValidExecutionResult(result);
			expect(result.success).toBe(false);
			expect(result.errors).toEqual({ message: "Bun execution failed", code: 500 });
		});

		it("should catch and handle thrown errors", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = {
				run: vi.fn().mockRejectedValue(new Error("Bun crash")),
			} as unknown as RunnerNode;

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.data).toBeNull();
			expect(result.errors).toBeDefined();
			expect(result.errors).toHaveProperty("message", "Bun crash");
			expect(result.errors).toHaveProperty("name");
			expect(result.errors).toHaveProperty("stack");
		});

		it("should handle async errors", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = {
				run: vi.fn(async () => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					throw new Error("Async bun error");
				}),
			} as unknown as RunnerNode;

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.errors).toHaveProperty("message", "Async bun error");
		});

		it("should handle nodes that return undefined success", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = createMockNodeWithRun({
				success: undefined as any,
				data: { result: "data" },
				error: null,
			});

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ result: "data" });
		});
	});

	describe("execute() - Performance", () => {
		it("should measure execution duration accurately", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const delayMs = 50;
			const mockNode = createDelayedMockNode(delayMs);

			const { result, duration } = await measureExecutionTime(() => adapter.execute(mockNode, mockContext));

			expect(result.metrics?.duration_ms).toBeDefined();
			assertExecutionTimeWithinRange(result.metrics!.duration_ms!, duration, 20);
			expect(result.metrics!.duration_ms!).toBeGreaterThanOrEqual(delayMs - 10);
		});

		it("should execute with minimal overhead for fast nodes", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = createMockNodeWithRun({
				success: true,
				data: {},
				error: null,
			});

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.metrics?.duration_ms).toBeLessThan(50);
		});

		it("should handle concurrent executions", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = createMockNodeWithRun({
				success: true,
				data: { result: "concurrent-bun" },
				error: null,
			});

			const promises = Array(10)
				.fill(null)
				.map(() => adapter.execute(mockNode, mockContext));

			const results = await Promise.all(promises);

			expect(results).toHaveLength(10);
			for (const result of results) {
				expect(result.success).toBe(true);
				expect(result.data).toEqual({ result: "concurrent-bun" });
			}
		});
	});

	describe("execute() - ExecutionResult Structure", () => {
		it("should return ExecutionResult with all required fields", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = createMockNodeWithRun({
				success: true,
				data: { test: "data" },
				error: null,
			});

			const result = await adapter.execute(mockNode, mockContext);

			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("data");
			expect(result).toHaveProperty("errors");
			expect(result).toHaveProperty("metrics");
			expect(result.metrics).toHaveProperty("duration_ms");
			expect(typeof result.success).toBe("boolean");
			expect(typeof result.metrics!.duration_ms).toBe("number");
		});

		it("should map success responses correctly", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = createMockNodeWithRun({
				success: true,
				data: { message: "bun success" },
				error: null,
			});

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ message: "bun success" });
			expect(result.errors).toBeNull();
		});

		it("should map failure responses correctly", async () => {
			(adapter as any).isBunRuntime = true;

			const mockContext = createMockContext();
			const mockNode = createMockNodeWithRun({
				success: false,
				data: null,
				error: { message: "failure", code: 500 },
			});

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.data).toBeNull();
			expect(result.errors).toEqual({ message: "failure", code: 500 });
		});
	});

	describe("Subprocess Mode", () => {
		it("should detect non-Bun runtime", () => {
			// In test environment (Node.js), isBunRuntime should be false
			const freshAdapter = new BunRuntimeAdapter();
			expect((freshAdapter as any).isBunRuntime).toBe(false);
		});

		it("should handle subprocess execution failure gracefully", async () => {
			// Ensure subprocess mode (non-Bun environment)
			(adapter as any).isBunRuntime = false;

			const mockContext = createMockContext();
			const mockNode = {
				name: "test-node",
				node: "nonexistent-module",
				type: "module",
				run: vi.fn(),
			} as unknown as RunnerNode;

			const result = await adapter.execute(mockNode, mockContext);

			// Should fail gracefully since bun binary likely not available in test
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});
	});
});

// Test Helper Functions

function createMockNodeWithRun(response: {
	success: boolean | undefined;
	data: any;
	error: any;
}): RunnerNode {
	return {
		run: vi.fn().mockResolvedValue(response),
	} as unknown as RunnerNode;
}

function createDelayedMockNode(delayMs: number): RunnerNode {
	return {
		run: vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return { success: true, data: {}, error: null };
		}),
	} as unknown as RunnerNode;
}
