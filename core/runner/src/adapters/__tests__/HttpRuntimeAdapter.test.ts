import type { Context } from "@blok/shared";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockRunnerNode } from "../../../test/helpers/test-utils";
import type RunnerNode from "../../RunnerNode";
import { HttpRuntimeAdapter } from "../HttpRuntimeAdapter";

// Mock global fetch
global.fetch = vi.fn();

describe("HttpRuntimeAdapter", () => {
	let adapter: HttpRuntimeAdapter;
	let mockContext: Context;
	let mockNode: RunnerNode;

	beforeEach(() => {
		vi.clearAllMocks();

		mockContext = createMockContext();
		mockNode = createMockRunnerNode({
			node: "chain-test",
			name: "go",
			runtime: "go",
		});

		adapter = new HttpRuntimeAdapter("go", "localhost", 9001);

		// Mock successful execution response by default
		vi.mocked(fetch).mockImplementation((url: any) => {
			if (typeof url === "string" && url.includes("/health")) {
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
						data: { chain: [{ language: "go", order: 1 }], origin: "test" },
						errors: null,
					}),
			} as Response);
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("Adapter Properties", () => {
		it("should have correct kind", () => {
			expect(adapter.kind).toBe("go");
		});

		it("should support different runtime kinds", () => {
			const rustAdapter = new HttpRuntimeAdapter("rust", "localhost", 9002);
			expect(rustAdapter.kind).toBe("rust");

			const javaAdapter = new HttpRuntimeAdapter("java", "localhost", 9003);
			expect(javaAdapter.kind).toBe("java");
		});

		it("should have execute method", () => {
			expect(adapter.execute).toBeDefined();
			expect(typeof adapter.execute).toBe("function");
		});

		it("should construct correct base URL", () => {
			expect(adapter.getBaseUrl()).toBe("http://localhost:9001");
		});

		it("should support custom host and port", () => {
			const customAdapter = new HttpRuntimeAdapter("csharp", "192.168.1.100", 8080);
			expect(customAdapter.getBaseUrl()).toBe("http://192.168.1.100:8080");
		});
	});

	describe("execute() - Success Cases", () => {
		it("should execute successfully and return ExecutionResult", async () => {
			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				chain: [{ language: "go", order: 1 }],
				origin: "test",
			});
			expect(result.errors).toBeNull();
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});

		it("should POST to /execute endpoint", async () => {
			await adapter.execute(mockNode, mockContext);

			expect(fetch).toHaveBeenCalledWith(
				"http://localhost:9001/execute",
				expect.objectContaining({
					method: "POST",
					headers: { "Content-Type": "application/json" },
				}),
			);
		});

		it("should include metrics from SDK container response", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						success: true,
						data: { result: "ok" },
						errors: null,
						metrics: { duration_ms: 5, cpu_ms: 2, memory_bytes: 1024 },
					}),
			} as Response);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.metrics?.cpu_ms).toBe(2);
			expect(result.metrics?.memory_bytes).toBe(1024);
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});

		it("should include logs from SDK container response", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						success: true,
						data: { result: "ok" },
						errors: null,
						logs: ["Processing started", "Processing complete"],
					}),
			} as Response);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.logs).toEqual(["Processing started", "Processing complete"]);
		});

		it("should handle null success field as true", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						data: { result: "ok" },
						errors: null,
					}),
			} as Response);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
		});
	});

	describe("execute() - Data Flow", () => {
		it("should place ctx.response.data into request.body of ExecutionRequest", async () => {
			const chainData = {
				chain: [{ language: "nodejs", order: 1 }],
				origin: "blok-cross-runtime-test",
			};

			const ctx = createMockContext();
			(ctx.response as any) = { data: chainData, success: true, error: null };

			await adapter.execute(mockNode, ctx);

			const fetchCall = vi.mocked(fetch).mock.calls[0];
			const body = JSON.parse(fetchCall[1]?.body as string);

			expect(body.context.request.body).toEqual(chainData);
		});

		it("should use empty object when ctx.response.data is null", async () => {
			const ctx = createMockContext();
			(ctx.response as any) = { data: null, success: true, error: null };

			await adapter.execute(mockNode, ctx);

			const fetchCall = vi.mocked(fetch).mock.calls[0];
			const body = JSON.parse(fetchCall[1]?.body as string);

			expect(body.context.request.body).toEqual({});
		});

		it("should include node name in ExecutionRequest", async () => {
			await adapter.execute(mockNode, mockContext);

			const fetchCall = vi.mocked(fetch).mock.calls[0];
			const body = JSON.parse(fetchCall[1]?.body as string);

			expect(body.node.name).toBe("chain-test");
		});

		it("should include workflow context fields", async () => {
			const ctx = createMockContext();
			(ctx as any).id = "test-workflow-123";
			(ctx as any).workflow_name = "cross-runtime-chain";
			(ctx as any).workflow_path = "/cross-runtime-chain";

			await adapter.execute(mockNode, ctx);

			const fetchCall = vi.mocked(fetch).mock.calls[0];
			const body = JSON.parse(fetchCall[1]?.body as string);

			expect(body.context.id).toBe("test-workflow-123");
			expect(body.context.workflow_name).toBe("cross-runtime-chain");
			expect(body.context.workflow_path).toBe("/cross-runtime-chain");
		});

		it("should include vars and env in context", async () => {
			const ctx = createMockContext();
			(ctx as any).vars = { key1: "value1" };
			(ctx as any).env = { API_KEY: "secret" };

			await adapter.execute(mockNode, ctx);

			const fetchCall = vi.mocked(fetch).mock.calls[0];
			const body = JSON.parse(fetchCall[1]?.body as string);

			expect(body.context.vars).toEqual({ key1: "value1" });
			expect(body.context.env).toEqual({ API_KEY: "secret" });
		});

		it("should use resolved inputs from config when available", async () => {
			const ctx = createMockContext();
			(ctx.response as any) = {
				data: { chain: [{ language: "nodejs", order: 1 }], origin: "test" },
				success: true,
				error: null,
			};
			// Simulate Mapper-resolved inputs in config
			(ctx as any).config = {
				go: {
					inputs: {
						chain: [{ language: "nodejs", order: 1 }],
						origin: "resolved-origin",
					},
				},
			};

			await adapter.execute(mockNode, ctx);

			const fetchCall = vi.mocked(fetch).mock.calls[0];
			const body = JSON.parse(fetchCall[1]?.body as string);

			// Should use resolved inputs (note: "resolved-origin" not "test")
			expect(body.context.request.body).toEqual({
				chain: [{ language: "nodejs", order: 1 }],
				origin: "resolved-origin",
			});
		});

		it("should fall back to ctx.response.data when no resolved inputs", async () => {
			const ctx = createMockContext();
			(ctx.response as any) = {
				data: { chain: [{ language: "nodejs", order: 1 }], origin: "fallback" },
				success: true,
				error: null,
			};
			// No inputs in config
			(ctx as any).config = { go: {} };

			await adapter.execute(mockNode, ctx);

			const fetchCall = vi.mocked(fetch).mock.calls[0];
			const body = JSON.parse(fetchCall[1]?.body as string);

			// Should fall back to ctx.response.data
			expect(body.context.request.body).toEqual({
				chain: [{ language: "nodejs", order: 1 }],
				origin: "fallback",
			});
		});

		it("should include node config in ExecutionRequest", async () => {
			const ctx = createMockContext();
			(ctx as any).config = {
				go: {
					inputs: { chain: [], origin: "test" },
					timeout: 5000,
				},
			};

			await adapter.execute(mockNode, ctx);

			const fetchCall = vi.mocked(fetch).mock.calls[0];
			const body = JSON.parse(fetchCall[1]?.body as string);

			expect(body.node.config).toEqual({
				inputs: { chain: [], origin: "test" },
				timeout: 5000,
			});
		});

		it("should return vars from SDK response when present", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						success: true,
						data: { chain: [{ language: "go", order: 1 }], origin: "test" },
						errors: null,
						vars: { chain: [{ language: "go", order: 1 }], go_processed: true },
					}),
			} as Response);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.vars).toEqual({
				chain: [{ language: "go", order: 1 }],
				go_processed: true,
			});
		});

		it("should not include vars when SDK response has no vars", async () => {
			const result = await adapter.execute(mockNode, mockContext);

			expect(result.vars).toBeUndefined();
		});

		it("should reset response to clean state in outgoing request", async () => {
			const ctx = createMockContext();
			(ctx.response as any) = {
				data: { some: "data" },
				success: true,
				error: { message: "previous error" },
			};

			await adapter.execute(mockNode, ctx);

			const fetchCall = vi.mocked(fetch).mock.calls[0];
			const body = JSON.parse(fetchCall[1]?.body as string);

			// The outgoing response should be clean (not carry previous step errors)
			expect(body.context.response.data).toBeNull();
			expect(body.context.response.success).toBe(true);
			expect(body.context.response.error).toBeNull();
		});
	});

	describe("execute() - Error Cases", () => {
		it("should handle network errors (ECONNREFUSED)", async () => {
			vi.mocked(fetch).mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.data).toBeNull();
			expect((result.errors as any).message).toContain("ECONNREFUSED");
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});

		it("should handle HTTP error status codes", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			} as Response);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect((result.errors as any).message).toContain("HTTP 500");
			expect((result.errors as any).message).toContain("Internal Server Error");
		});

		it("should handle SDK node failure (success: false)", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						success: false,
						data: null,
						errors: { message: "Node execution failed", code: "NODE_ERROR" },
					}),
			} as Response);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.errors).toEqual({ message: "Node execution failed", code: "NODE_ERROR" });
		});

		it("should handle timeout errors", async () => {
			const slowAdapter = new HttpRuntimeAdapter("go", "localhost", 9001, {
				timeoutMs: 100,
			});

			vi.mocked(fetch).mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

			const result = await slowAdapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect((result.errors as any).message).toContain("aborted");
		});

		it("should handle invalid JSON response", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.reject(new SyntaxError("Unexpected token")),
			} as Response);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect((result.errors as any).message).toContain("Unexpected token");
		});

		it("should always include duration_ms in metrics on error", async () => {
			vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.metrics).toBeDefined();
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});

		it("should include error name and stack in error result", async () => {
			const error = new TypeError("Invalid response");
			vi.mocked(fetch).mockRejectedValueOnce(error);

			const result = await adapter.execute(mockNode, mockContext);

			expect((result.errors as any).name).toBe("TypeError");
			expect((result.errors as any).stack).toBeDefined();
		});
	});

	describe("checkHealth()", () => {
		it("should return true for healthy container", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ status: "healthy" }),
			} as Response);

			const healthy = await adapter.checkHealth();

			expect(healthy).toBe(true);
			expect(fetch).toHaveBeenCalledWith("http://localhost:9001/health", expect.objectContaining({ method: "GET" }));
		});

		it("should return true for status 'ok'", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ status: "ok" }),
			} as Response);

			const healthy = await adapter.checkHealth();

			expect(healthy).toBe(true);
		});

		it("should return false for unhealthy container", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ status: "unhealthy" }),
			} as Response);

			const healthy = await adapter.checkHealth();

			expect(healthy).toBe(false);
		});

		it("should return false for HTTP error", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: false,
				status: 503,
			} as Response);

			const healthy = await adapter.checkHealth();

			expect(healthy).toBe(false);
		});

		it("should return false when container is unreachable", async () => {
			vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

			const healthy = await adapter.checkHealth();

			expect(healthy).toBe(false);
		});
	});

	describe("All Runtime Kinds", () => {
		const runtimes = [
			{ kind: "go" as const, port: 9001 },
			{ kind: "rust" as const, port: 9002 },
			{ kind: "java" as const, port: 9003 },
			{ kind: "csharp" as const, port: 9004 },
			{ kind: "php" as const, port: 9005 },
			{ kind: "ruby" as const, port: 9006 },
		];

		for (const { kind, port } of runtimes) {
			it(`should create adapter for ${kind} runtime`, () => {
				const rt = new HttpRuntimeAdapter(kind, "localhost", port);
				expect(rt.kind).toBe(kind);
				expect(rt.getBaseUrl()).toBe(`http://localhost:${port}`);
			});
		}

		it("should execute on all 6 runtime kinds", async () => {
			for (const { kind, port } of runtimes) {
				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							data: { language: kind },
							errors: null,
						}),
				} as Response);

				const rt = new HttpRuntimeAdapter(kind, "localhost", port);
				const result = await rt.execute(mockNode, mockContext);

				expect(result.success).toBe(true);
				expect((result.data as any).language).toBe(kind);
			}
		});
	});
});
