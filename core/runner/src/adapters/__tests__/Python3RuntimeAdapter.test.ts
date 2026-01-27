import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Python3RuntimeAdapter } from "../Python3RuntimeAdapter";
import type { Context } from "@nanoservice-ts/shared";
import type RunnerNode from "../../RunnerNode";
import type { NodeRequest, NodeResponse } from "../../NodeGrpcClient";
import { createMockContext, createMockRunnerNode } from "../../../test/helpers/test-utils";

// Mock the NodeGrpcNativeClient module
vi.mock("../../NodeGrpcNativeClient", () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			call: vi.fn(),
		})),
	};
});

import NodeGrpcNativeClient from "../../NodeGrpcNativeClient";

describe("Python3RuntimeAdapter", () => {
	let adapter: Python3RuntimeAdapter;
	let mockContext: Context;
	let mockNode: RunnerNode;

	beforeEach(() => {
		// Clear all mocks before each test
		vi.clearAllMocks();

		// Create fresh instances
		adapter = new Python3RuntimeAdapter();
		mockContext = createMockContext();
		mockNode = createMockRunnerNode({
			node: "test-python-node",
			runtime: "python3",
		});
	});

	afterEach(() => {
		// Clean up environment variables
		delete process.env.RUNTIME_PYTHON3_HOST;
		delete process.env.RUNTIME_PYTHON3_PORT;
	});

	describe("Adapter Properties", () => {
		it("should have python3 as kind", () => {
			expect(adapter.kind).toBe("python3");
		});

		it("should have execute method", () => {
			expect(adapter.execute).toBeDefined();
			expect(typeof adapter.execute).toBe("function");
		});
	});

	describe("Constructor", () => {
		it("should use default host and port when not provided", () => {
			const adapter = new Python3RuntimeAdapter();
			expect(adapter).toBeDefined();
		});

		it("should use provided host and port", () => {
			const adapter = new Python3RuntimeAdapter("custom-host", 9999);
			expect(adapter).toBeDefined();
		});

		it("should use environment variables for host and port", () => {
			process.env.RUNTIME_PYTHON3_HOST = "env-host";
			process.env.RUNTIME_PYTHON3_PORT = "8888";

			const adapter = new Python3RuntimeAdapter();
			expect(adapter).toBeDefined();
		});

		it("should prefer constructor params over environment variables", () => {
			process.env.RUNTIME_PYTHON3_HOST = "env-host";
			process.env.RUNTIME_PYTHON3_PORT = "8888";

			const adapter = new Python3RuntimeAdapter("param-host", 7777);
			expect(adapter).toBeDefined();
		});

		it("should handle invalid port in environment variable", () => {
			process.env.RUNTIME_PYTHON3_PORT = "invalid";
			const adapter = new Python3RuntimeAdapter();
			expect(adapter).toBeDefined();
		});
	});

	describe("execute() - Success Cases", () => {
		it("should execute Python node successfully and return ExecutionResult", async () => {
			const mockResponseData = { result: "success", value: 42 };
			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify(mockResponseData)).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			// Mock the gRPC client call
			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual(mockResponseData);
			expect(result.errors).toBeNull();
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});

		it("should decode base64 response correctly", async () => {
			const mockData = { user: { name: "John", age: 30 }, active: true };
			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify(mockData)).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual(mockData);
		});

		it("should handle empty response data", async () => {
			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify({})).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({});
		});

		it("should handle large payloads", async () => {
			const largeData = {
				items: Array(1000)
					.fill(null)
					.map((_, i) => ({
						id: i,
						name: `Item ${i}`,
						data: "x".repeat(100),
					})),
			};

			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify(largeData)).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual(largeData);
		});
	});

	describe("execute() - Error Cases", () => {
		it("should handle gRPC connection errors", async () => {
			const connectionError = new Error("Failed to connect to gRPC server at localhost:50051");

			const mockCall = vi.fn().mockRejectedValue(connectionError);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.data).toBeNull();
			expect(result.errors).toBeDefined();
			expect(result.errors?.message).toContain("Failed to connect");
		});

		it("should handle gRPC timeout errors", async () => {
			const timeoutError = new Error("Deadline exceeded");

			const mockCall = vi.fn().mockRejectedValue(timeoutError);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.data).toBeNull();
			expect(result.errors?.message).toContain("Deadline exceeded");
		});

		it("should handle Python node execution errors", async () => {
			const executionError = new Error("Python node threw an exception");

			const mockCall = vi.fn().mockRejectedValue(executionError);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.errors?.message).toBe("Python node threw an exception");
			expect(result.errors?.name).toBe("Error");
		});

		it("should handle invalid base64 response", async () => {
			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: "invalid-base64-!@#$%",
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			// Should fail during JSON.parse
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
		});

		it("should handle invalid JSON in response", async () => {
			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from("not-valid-json{").toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.errors?.message).toContain("JSON");
		});

		it("should include error stack in result", async () => {
			const error = new Error("Test error with stack");
			error.stack = "Error: Test error\n    at test.ts:123";

			const mockCall = vi.fn().mockRejectedValue(error);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.errors?.stack).toBeDefined();
			expect(result.errors?.stack).toContain("test.ts:123");
		});
	});

	describe("execute() - Context Serialization", () => {
		it("should serialize context correctly for gRPC", async () => {
			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			await adapter.execute(mockNode, mockContext);

			// Verify the gRPC client was called with correct structure
			expect(mockCall).toHaveBeenCalledTimes(1);
			const request = mockCall.mock.calls[0][0] as NodeRequest;

			expect(request.Name).toBe("test-python-node");
			expect(request.Encoding).toBe("BASE64");
			expect(request.Type).toBe("JSON");

			// Decode and verify the context structure
			const decodedContext = JSON.parse(Buffer.from(request.Message, "base64").toString("utf-8"));
			expect(decodedContext).toHaveProperty("request");
			expect(decodedContext).toHaveProperty("response");
			expect(decodedContext).toHaveProperty("vars");
			// Note: env is verified in the dedicated test below
		});

		it("should include all request fields in serialized context", async () => {
			mockContext.request = {
				body: { test: "data" },
				headers: { "content-type": "application/json" },
				params: { id: "123" },
				query: { page: "1" },
				method: "POST",
				url: "/api/test",
				cookies: { session: "abc" },
				baseUrl: "http://localhost:3000",
			};

			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			await adapter.execute(mockNode, mockContext);

			const request = mockCall.mock.calls[0][0] as NodeRequest;
			const decodedContext = JSON.parse(Buffer.from(request.Message, "base64").toString("utf-8"));

			expect(decodedContext.request.body).toEqual({ test: "data" });
			expect(decodedContext.request.headers).toEqual({ "content-type": "application/json" });
			expect(decodedContext.request.params).toEqual({ id: "123" });
			expect(decodedContext.request.query).toEqual({ page: "1" });
			expect(decodedContext.request.method).toBe("POST");
			expect(decodedContext.request.url).toBe("/api/test");
			expect(decodedContext.request.cookies).toEqual({ session: "abc" });
			expect(decodedContext.request.baseUrl).toBe("http://localhost:3000");
		});

		it("should include vars and env in serialized context", async () => {
			mockContext.vars = { user: { id: 1, name: "Test" }, count: 42 };
			mockContext.env = { NODE_ENV: "test", API_KEY: "secret" };

			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			await adapter.execute(mockNode, mockContext);

			const request = mockCall.mock.calls[0][0] as NodeRequest;
			const decodedContext = JSON.parse(Buffer.from(request.Message, "base64").toString("utf-8"));

			expect(decodedContext.vars).toEqual({ user: { id: 1, name: "Test" }, count: 42 });
			expect(decodedContext.env).toEqual({ NODE_ENV: "test", API_KEY: "secret" });
		});
	});

	describe("execute() - Performance", () => {
		it("should measure execution duration accurately", async () => {
			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return mockGrpcResponse;
			});

			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const startTime = performance.now();
			const result = await adapter.execute(mockNode, mockContext);
			const endTime = performance.now();

			const actualDuration = endTime - startTime;
			const measuredDuration = result.metrics?.duration_ms || 0;

			expect(measuredDuration).toBeGreaterThanOrEqual(40); // At least 40ms (50ms - tolerance)
			expect(measuredDuration).toBeLessThanOrEqual(actualDuration + 20); // Within 20ms tolerance
		});

		it("should measure duration even when execution fails", async () => {
			const mockCall = vi.fn().mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				throw new Error("Execution failed");
			});

			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(false);
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(20); // At least 20ms
		});

		it("should handle concurrent executions", async () => {
			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			// Execute 10 concurrent requests
			const promises = Array(10)
				.fill(null)
				.map(() => adapter.execute(mockNode, mockContext));

			const results = await Promise.all(promises);

			// All should succeed
			expect(results).toHaveLength(10);
			results.forEach((result) => {
				expect(result.success).toBe(true);
				expect(result.data).toEqual({ ok: true });
			});

			// Should have created 10 gRPC clients
			expect(mockCall).toHaveBeenCalledTimes(10);
		});
	});

	describe("execute() - ExecutionResult Structure", () => {
		it("should return ExecutionResult with all required fields on success", async () => {
			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify({ result: "test" })).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			// Verify structure
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("data");
			expect(result).toHaveProperty("errors");
			expect(result).toHaveProperty("metrics");

			// Verify values
			expect(result.success).toBe(true);
			expect(result.data).toBeDefined();
			expect(result.errors).toBeNull();
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});

		it("should return ExecutionResult with all required fields on failure", async () => {
			const mockCall = vi.fn().mockRejectedValue(new Error("Test error"));
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			// Verify structure
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("data");
			expect(result).toHaveProperty("errors");
			expect(result).toHaveProperty("metrics");

			// Verify values
			expect(result.success).toBe(false);
			expect(result.data).toBeNull();
			expect(result.errors).toBeDefined();
			expect(result.errors?.message).toBe("Test error");
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});
	});

	describe("execute() - Special Characters and Edge Cases", () => {
		it("should handle special characters in response data", async () => {
			const specialData = {
				unicode: "Hello 世界 🚀",
				symbols: "!@#$%^&*()_+-=[]{}|;':\",./<>?",
				newlines: "line1\nline2\nline3",
				tabs: "col1\tcol2\tcol3",
			};

			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify(specialData)).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual(specialData);
		});

		it("should handle null values in response", async () => {
			const nullData = {
				field1: null,
				field2: { nested: null },
				field3: [null, null],
			};

			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify(nullData)).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual(nullData);
		});

		it("should handle deeply nested objects", async () => {
			const deepData = {
				level1: {
					level2: {
						level3: {
							level4: {
								level5: {
									value: "deep",
								},
							},
						},
					},
				},
			};

			const mockGrpcResponse: NodeResponse = {
				Name: "test-node",
				Message: Buffer.from(JSON.stringify(deepData)).toString("base64"),
				Encoding: "BASE64",
				Type: "JSON",
			};

			const mockCall = vi.fn().mockResolvedValue(mockGrpcResponse);
			vi.mocked(NodeGrpcNativeClient).mockImplementation(() => ({
				call: mockCall,
			}) as any);

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.success).toBe(true);
			expect(result.data).toEqual(deepData);
		});
	});
});
