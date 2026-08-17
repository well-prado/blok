/**
 * Unit Tests for BunRuntimeAdapter
 * Tests in-process and subprocess Bun node execution
 */

import type { Context } from "@blokjs/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertExecutionTimeWithinRange,
	assertValidExecutionResult,
	createMockContext,
	measureExecutionTime,
} from "../../../test/helpers/test-utils";
import type RunnerNode from "../../RunnerNode";
import { BunRuntimeAdapter } from "../BunRuntimeAdapter";

// `executeViaSubprocess` shells out to `bun eval`. Stub it so the subprocess
// tests are hermetic (they no longer depend on whether a `bun` binary exists
// on PATH) and so the payload argv can be inspected. Default behavior is a
// spawn failure, which is what the pre-existing failure test asserts.
const subprocess = vi.hoisted(() => ({
	argv: null as string[] | null,
	behavior: "fail" as "fail" | "ok",
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: (_file: string, args: string[], _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
			subprocess.argv = args;
			if (subprocess.behavior === "fail") cb(new Error("bun: command not found"));
			else cb(null, { stdout: JSON.stringify({ success: true, data: {}, errors: null }), stderr: "" });
			return {};
		},
	};
});

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
			expect((capturedContext as { id?: string } | null)?.id).toBe("bun-test-id");
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

		// #895 — the subprocess payload used to inline `ctx.vars` (EVERY
		// completed step's output) and the previous step's output on every
		// call: the same O(n²) growth term #885 removed from the gRPC codec.
		it("should NOT ship accumulated state or the previous output", async () => {
			(adapter as any).isBunRuntime = false;

			const mockContext = createMockContext({
				vars: { "step-1": "a".repeat(1024), "step-2": "b".repeat(1024) },
				response: { data: { previous: "output" }, error: null, success: true },
			});

			const payload = await captureSubprocessPayload(adapter, mockContext);

			expect(payload.context.vars).toEqual({});
			expect(payload.context.response.data).toBeNull();
			expect(JSON.stringify(payload)).not.toContain("a".repeat(64));
			expect(JSON.stringify(payload)).not.toContain("b".repeat(64));
		});

		it("should ship the full state bag when the diet is switched off", async () => {
			process.env.BLOK_RUNTIME_STATE_DIET = "0";
			try {
				(adapter as any).isBunRuntime = false;

				const mockContext = createMockContext({
					vars: { "step-1": "kept" },
					response: { data: { previous: "output" }, error: null, success: true },
				});

				const payload = await captureSubprocessPayload(adapter, mockContext);

				expect(payload.context.vars).toEqual({ "step-1": "kept" });
				expect(payload.context.response.data).toEqual({ previous: "output" });
			} finally {
				// biome-ignore lint/performance/noDelete: must fully unset, not store "undefined"
				delete process.env.BLOK_RUNTIME_STATE_DIET;
			}
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

/**
 * Run the subprocess path and return the JSON payload the adapter handed to
 * the child process — `bun eval <script> <payload>`, so argv[2].
 */
async function captureSubprocessPayload(adapter: BunRuntimeAdapter, ctx: Context): Promise<any> {
	subprocess.behavior = "ok";
	subprocess.argv = null;
	const mockNode = {
		name: "test-node",
		node: "some-module",
		type: "module",
		run: vi.fn(),
	} as unknown as RunnerNode;

	try {
		await adapter.execute(mockNode, ctx);
		return JSON.parse(subprocess.argv![2]);
	} finally {
		subprocess.behavior = "fail";
	}
}

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
