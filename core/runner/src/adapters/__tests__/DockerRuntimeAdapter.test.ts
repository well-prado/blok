import { exec } from "node:child_process";
import type { Context } from "@blokjs/shared";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockRunnerNode } from "../../../test/helpers/test-utils";
import type RunnerNode from "../../RunnerNode";
import { DockerRuntimeAdapter } from "../DockerRuntimeAdapter";

// Mock child_process exec
vi.mock("node:child_process", () => ({
	exec: vi.fn(),
}));

// Mock promisify to return the mocked exec
vi.mock("node:util", () => ({
	promisify: vi.fn((fn) => fn),
}));

// Mock global fetch
global.fetch = vi.fn();

describe("DockerRuntimeAdapter", () => {
	let adapter: DockerRuntimeAdapter;
	let mockContext: Context;
	let mockNode: RunnerNode;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers(); // Use fake timers for each test

		mockContext = createMockContext();
		mockNode = createMockRunnerNode({
			node: "test-node",
			runtime: "docker",
		});

		// Setup mocks BEFORE creating adapter

		// Mock successful docker run with Promise support for promisify
		vi.mocked(exec).mockImplementation((cmd: string, callback?: any) => {
			const result = { stdout: "", stderr: "" };

			if (cmd.includes("docker run")) {
				result.stdout = "container-id-123\n";
			}

			// If callback provided, call it async style
			if (callback) {
				setImmediate(() => callback(null, result));
			}

			// Return a promise-like object for promisify compatibility
			return Promise.resolve(result) as any;
		});

		// Mock successful health check by default
		vi.mocked(fetch).mockImplementation((url: any) => {
			if (url.includes("/health")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ status: "healthy" }),
				} as Response);
			}
			return Promise.resolve({
				ok: true,
				json: () =>
					Promise.resolve({
						success: true,
						data: { result: "test" },
						errors: null,
					}),
			} as Response);
		});
	});

	afterEach(async () => {
		if (adapter) {
			await adapter.shutdown();
		}
		// Clear any pending timers
		vi.clearAllTimers();
		vi.useRealTimers(); // Restore real timers after each test
	});

	describe("Adapter Properties", () => {
		it("should have correct kind", () => {
			adapter = new DockerRuntimeAdapter("go", "blok-go-runtime:latest");
			expect(adapter.kind).toBe("go");
		});

		// Removed: "should default to docker kind". The constructor previously
		// defaulted `kind` to `"docker"`, but the multi-language runtime
		// matrix has no sensible default and biome's `useDefaultParameterLast`
		// rule autofixed the signature to drop the default. Callers now MUST
		// pass an explicit kind.

		it("should have execute method", () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image");
			expect(adapter.execute).toBeDefined();
			expect(typeof adapter.execute).toBe("function");
		});
	});

	describe("Constructor", () => {
		it("should create adapter with default config", () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image");
			expect(adapter).toBeDefined();
		});

		it("should create adapter with custom config", () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 2,
				maxInstances: 10,
			});
			expect(adapter).toBeDefined();
		});

		it("should handle initialization with min instances", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 2,
			});

			// Flush all promises and timers
			await vi.runOnlyPendingTimersAsync();

			// Should have attempted to create containers
			const dockerRunCalls = vi.mocked(exec).mock.calls.filter((call) => call[0].includes("docker run"));
			expect(dockerRunCalls.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("execute() - Success Cases", () => {
		it("should execute node successfully", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			vi.mocked(fetch).mockImplementation((url: any) => {
				if (url.includes("/health")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ status: "healthy" }),
					} as Response);
				}
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							data: { output: "Hello from Docker!" },
							errors: null,
						}),
				} as Response);
			});

			const resultPromise = adapter.execute(mockNode, mockContext);

			// Advance timers to allow health checks
			await vi.runOnlyPendingTimersAsync();

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ output: "Hello from Docker!" });
			expect(result.errors).toBeNull();
		});

		it("should include metrics in result", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			const result = await resultPromise;

			expect(result.metrics?.duration_ms).toBeDefined();
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});

		it("should include response metrics", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			vi.mocked(fetch).mockImplementation((url: any) => {
				if (url.includes("/health")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ status: "healthy" }),
					} as Response);
				}
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							data: {},
							errors: null,
							metrics: {
								cpu_ms: 100,
								memory_bytes: 2048000,
							},
						}),
				} as Response);
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			const result = await resultPromise;

			expect(result.metrics?.cpu_ms).toBe(100);
			expect(result.metrics?.memory_bytes).toBe(2048000);
		});

		it("should include logs when provided", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			vi.mocked(fetch).mockImplementation((url: any) => {
				if (url.includes("/health")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ status: "healthy" }),
					} as Response);
				}
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							data: {},
							errors: null,
							logs: ["Starting execution", "Process complete"],
						}),
				} as Response);
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			const result = await resultPromise;

			expect(result.logs).toEqual(["Starting execution", "Process complete"]);
		});
	});

	describe("execute() - Error Cases", () => {
		it("should handle container creation failure", async () => {
			vi.mocked(exec).mockImplementation((cmd: string, callback: any) => {
				if (cmd.includes("docker run") && callback) {
					setImmediate(() => callback(new Error("Docker image not found"), { stdout: "", stderr: "error" }));
				}
				return null as any;
			});

			adapter = new DockerRuntimeAdapter("docker", "nonexistent:latest", {
				minInstances: 0,
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.data).toBeNull();
			expect(result.errors).toBeDefined();
			if (result.errors && typeof result.errors === "object" && "message" in result.errors) {
				expect((result.errors as { message: string }).message).toContain("Failed to create container");
			}
		});

		it("should handle health check timeout", async () => {
			vi.mocked(fetch).mockImplementation((url: any) => {
				if (url.includes("/health")) {
					// Always fail health check
					return Promise.resolve({
						ok: false,
					} as Response);
				}
				return Promise.resolve({ ok: true } as Response);
			});

			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			const resultPromise = adapter.execute(mockNode, mockContext);

			// Advance through all health check attempts (30 attempts with 1s delay each)
			for (let i = 0; i < 30; i++) {
				await vi.advanceTimersByTimeAsync(1000);
			}

			const result = await resultPromise;

			expect(result.success).toBe(false);
			if (result.errors && typeof result.errors === "object" && "message" in result.errors) {
				expect((result.errors as { message: string }).message).toContain("failed to become healthy");
			}
		});

		it("should handle execution failure", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			vi.mocked(fetch).mockImplementation((url: any) => {
				if (url.includes("/health")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ status: "healthy" }),
					} as Response);
				}
				return Promise.resolve({
					ok: false,
					statusText: "Internal Server Error",
				} as Response);
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			const result = await resultPromise;

			expect(result.success).toBe(false);
			if (result.errors && typeof result.errors === "object" && "message" in result.errors) {
				expect((result.errors as { message: string }).message).toContain("Container execution failed");
			}
		});

		it("should handle network errors", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			vi.mocked(fetch).mockImplementation((url: any) => {
				if (url.includes("/health")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ status: "healthy" }),
					} as Response);
				}
				return Promise.reject(new Error("ECONNREFUSED"));
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			const result = await resultPromise;

			expect(result.success).toBe(false);
			if (result.errors && typeof result.errors === "object" && "message" in result.errors) {
				expect((result.errors as { message: string }).message).toContain("ECONNREFUSED");
			}
		});

		it("should measure duration even on errors", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			vi.mocked(fetch).mockImplementation((url: any) => {
				if (url.includes("/health")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ status: "healthy" }),
					} as Response);
				}
				return Promise.reject(new Error("Test error"));
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});
	});

	describe("Container Pooling", () => {
		it("should create containers on demand", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
				maxInstances: 5,
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			await resultPromise;

			const dockerRunCalls = vi.mocked(exec).mock.calls.filter((call) => call[0].includes("docker run"));
			expect(dockerRunCalls.length).toBeGreaterThanOrEqual(1);
		});

		it("should reuse healthy containers", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 1,
			});

			// Wait for init by running timers
			await vi.runOnlyPendingTimersAsync();

			vi.clearAllMocks(); // Clear init calls

			// Execute twice
			const result1Promise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			await result1Promise;

			const result2Promise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			await result2Promise;

			// Should not create new containers (reuse existing)
			const dockerRunCalls = vi.mocked(exec).mock.calls.filter((call) => call[0].includes("docker run"));
			expect(dockerRunCalls.length).toBe(0);
		});

		it("should handle concurrent executions", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
				maxInstances: 3,
			});

			const promises = [
				adapter.execute(mockNode, mockContext),
				adapter.execute(mockNode, mockContext),
				adapter.execute(mockNode, mockContext),
			];

			// Advance timers for all executions
			await vi.runOnlyPendingTimersAsync();

			const results = await Promise.all(promises);

			expect(results).toHaveLength(3);
			for (const result of results) {
				expect(result.success).toBe(true);
			}
		});
	});

	describe("Context Serialization", () => {
		it("should send node and context to container", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			let capturedBody: any = null;

			vi.mocked(fetch).mockImplementation((url: any, options: any) => {
				if (url.includes("/health")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ status: "healthy" }),
					} as Response);
				}
				if (options?.body) {
					capturedBody = JSON.parse(options.body);
				}
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							data: {},
							errors: null,
						}),
				} as Response);
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			await resultPromise;

			expect(capturedBody).toBeDefined();
			expect(capturedBody.node).toBeDefined();
			expect(capturedBody.node.name).toBe("test-node");
			expect(capturedBody.context).toBeDefined();
		});

		it("should include request data in context", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			mockContext.request = {
				...mockContext.request,
				body: { test: "data" },
				headers: { "content-type": "application/json" },
				params: { id: "123" } as any,
				query: { page: "1" } as any,
				method: "POST",
				url: "/test",
			};

			let capturedBody: any = null;

			vi.mocked(fetch).mockImplementation((url: any, options: any) => {
				if (url.includes("/health")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ status: "healthy" }),
					} as Response);
				}
				if (options?.body) {
					capturedBody = JSON.parse(options.body);
				}
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							data: {},
							errors: null,
						}),
				} as Response);
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			await resultPromise;

			expect(capturedBody.context.request.body).toEqual({ test: "data" });
			expect(capturedBody.context.request.method).toBe("POST");
		});

		it("should include node config when available", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			mockContext.config = {
				"test-node": {
					apiKey: "secret",
				},
			} as Record<string, unknown>;
			mockNode.name = "test-node";

			let capturedBody: any = null;

			vi.mocked(fetch).mockImplementation((url: any, options: any) => {
				if (url.includes("/health")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ status: "healthy" }),
					} as Response);
				}
				if (options?.body) {
					capturedBody = JSON.parse(options.body);
				}
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							data: {},
							errors: null,
						}),
				} as Response);
			});

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			await resultPromise;

			expect(capturedBody.node.config).toEqual({ apiKey: "secret" });
		});
	});

	describe("shutdown()", () => {
		it("should stop all containers", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 2,
			});

			// Wait for init
			await vi.runOnlyPendingTimersAsync();

			vi.clearAllMocks();

			await adapter.shutdown();

			// Should have called docker stop
			const dockerStopCalls = vi.mocked(exec).mock.calls.filter((call) => call[0].includes("docker stop"));
			expect(dockerStopCalls.length).toBeGreaterThanOrEqual(1);
		});

		it("should handle shutdown errors gracefully", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 1,
			});

			await vi.runOnlyPendingTimersAsync();

			vi.mocked(exec).mockImplementation((cmd: string, callback: any) => {
				if (cmd.includes("docker stop") && callback) {
					setImmediate(() => callback(new Error("Already stopped"), { stdout: "", stderr: "" }));
				}
				return null as any;
			});

			// Should not throw
			await expect(adapter.shutdown()).resolves.not.toThrow();
		});

		it("should clear intervals", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 1,
			});

			await vi.runOnlyPendingTimersAsync();

			await adapter.shutdown();

			// After shutdown, adapter should still be defined
			expect(adapter).toBeDefined();
		});
	});

	describe("Performance", () => {
		it("should measure execution time accurately", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 0,
			});

			const startTime = performance.now();
			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			const result = await resultPromise;
			const endTime = performance.now();

			const actualDuration = endTime - startTime;
			const measuredDuration = result.metrics?.duration_ms || 0;

			expect(measuredDuration).toBeGreaterThanOrEqual(0);
			expect(measuredDuration).toBeLessThanOrEqual(actualDuration + 100);
		});

		it("should have low overhead with warm containers", async () => {
			adapter = new DockerRuntimeAdapter("docker", "test-image", {
				minInstances: 1,
			});

			// Wait for container to be ready
			await vi.runOnlyPendingTimersAsync();

			const resultPromise = adapter.execute(mockNode, mockContext);
			await vi.runOnlyPendingTimersAsync();
			const result = await resultPromise;

			// With warm container, should be relatively fast
			expect(result.metrics?.duration_ms).toBeDefined();
			expect(result.success).toBe(true);
		});
	});
});
