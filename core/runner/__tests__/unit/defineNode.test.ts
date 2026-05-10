/**
 * Unit tests for defineNode - Function-First Node API
 *
 * Test coverage:
 * - defineNode() helper function
 * - FunctionNode wrapper class
 * - Zod input validation
 * - Zod output validation
 * - GlobalError mapping
 * - Backward compatibility with BlokService
 */

import type { Context } from "@blokjs/shared";
import { GlobalError } from "@blokjs/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { IBlokResponse } from "../../src/BlokResponse";
import { FunctionNode, defineNode } from "../../src/defineNode";

// Test helper to create a minimal Context
function createTestContext(): Context {
	return {
		id: "test-id",
		workflow_name: "test-workflow",
		workflow_path: "/test",
		request: {
			body: {},
			headers: {},
			query: {},
			params: {},
		},
		response: {
			data: {},
			success: true,
			error: null,
		},
		error: {
			message: [],
		},
		logger: {
			log: vi.fn(),
			logLevel: vi.fn(),
			error: vi.fn(),
			getLogs: vi.fn(() => []),
			getLogsAsText: vi.fn(() => ""),
			getLogsAsBase64: vi.fn(() => ""),
		},
		config: {},
		vars: {},
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	};
}

describe("defineNode", () => {
	describe("Basic Functionality", () => {
		it("should create a FunctionNode instance", () => {
			const node = defineNode({
				name: "test-node",
				description: "Test node",
				input: z.object({ value: z.number() }),
				output: z.object({ result: z.number() }),
				async execute(ctx, input) {
					return { result: input.value * 2 };
				},
			});

			expect(node).toBeInstanceOf(FunctionNode);
			expect(node.name).toBe("test-node");
		});

		it("should set node name from definition", () => {
			const node = defineNode({
				name: "my-custom-node",
				description: "Custom node",
				input: z.object({}),
				output: z.object({}),
				async execute(ctx, input) {
					return {};
				},
			});

			expect(node.name).toBe("my-custom-node");
		});

		it("should set contentType when provided", () => {
			const node = defineNode({
				name: "html-node",
				description: "Returns HTML",
				contentType: "text/html",
				input: z.object({}),
				output: z.string(),
				async execute(ctx, input) {
					return "<h1>Hello</h1>";
				},
			});

			expect(node.contentType).toBe("text/html");
		});

		it("should use NodeBase default contentType when not provided", () => {
			const node = defineNode({
				name: "json-node",
				description: "Returns JSON",
				input: z.object({ value: z.number() }),
				output: z.object({ result: z.number() }),
				async execute(ctx, input) {
					return { result: input.value };
				},
			});

			// NodeBase defaults contentType to empty string ""
			// The runner/trigger sets the actual content type based on the response
			expect(node.contentType).toBe("");
		});

		it("should support application/pdf contentType", () => {
			const node = defineNode({
				name: "pdf-node",
				description: "Returns PDF",
				contentType: "application/pdf",
				input: z.object({ base64: z.string() }),
				output: z.string(),
				async execute(ctx, input) {
					return Buffer.from(input.base64, "base64").toString();
				},
			});

			expect(node.contentType).toBe("application/pdf");
		});

		it("should have input and output schemas", () => {
			const node = defineNode({
				name: "test-node",
				description: "Test",
				input: z.object({ a: z.string() }),
				output: z.object({ b: z.number() }),
				async execute(ctx, input) {
					return { b: 42 };
				},
			});

			expect(node.inputSchema).toBeDefined();
			expect(node.outputSchema).toBeDefined();
		});
	});

	describe("Successful Execution", () => {
		it("should execute successfully with valid input", async () => {
			const node = defineNode({
				name: "double-number",
				description: "Doubles a number",
				input: z.object({ value: z.number() }),
				output: z.object({ result: z.number() }),
				async execute(ctx, input) {
					return { result: input.value * 2 };
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { value: 5 })) as IBlokResponse;

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ result: 10 });
			expect(result.error).toBeNull();
		});

		it("should handle async operations", async () => {
			const node = defineNode({
				name: "async-node",
				description: "Async test",
				input: z.object({ delay: z.number() }),
				output: z.object({ completed: z.boolean() }),
				async execute(ctx, input) {
					await new Promise((resolve) => setTimeout(resolve, input.delay));
					return { completed: true };
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { delay: 10 })) as IBlokResponse;

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ completed: true });
		});

		it("should allow context access in execute function", async () => {
			const node = defineNode({
				name: "context-node",
				description: "Uses context",
				input: z.object({ value: z.string() }),
				output: z.object({ stored: z.boolean() }),
				async execute(ctx, input) {
					ctx.logger.log("Processing value");
					if (ctx.vars) {
						ctx.vars["my-value"] = input.value;
					}
					return { stored: true };
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { value: "test" })) as IBlokResponse;

			expect(result.success).toBe(true);
			expect(ctx.vars?.["my-value"]).toBe("test");
			expect(ctx.logger.log).toHaveBeenCalledWith("Processing value");
		});

		it("should handle complex nested objects", async () => {
			const node = defineNode({
				name: "complex-node",
				description: "Complex data",
				input: z.object({
					user: z.object({
						id: z.string(),
						profile: z.object({
							name: z.string(),
							age: z.number(),
						}),
					}),
				}),
				output: z.object({
					processed: z.boolean(),
					userName: z.string(),
				}),
				async execute(ctx, input) {
					return {
						processed: true,
						userName: input.user.profile.name,
					};
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, {
				user: {
					id: "123",
					profile: {
						name: "John",
						age: 30,
					},
				},
			})) as IBlokResponse;

			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				processed: true,
				userName: "John",
			});
		});
	});

	describe("Input Validation", () => {
		it("should validate input and reject invalid data", async () => {
			const node = defineNode({
				name: "validation-node",
				description: "Validates input",
				input: z.object({
					email: z.string().email(),
					age: z.number().positive(),
				}),
				output: z.object({ valid: z.boolean() }),
				async execute(ctx, input) {
					return { valid: true };
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, {
				email: "not-an-email",
				age: -5,
			})) as IBlokResponse;

			expect(result.success).toBe(false);
			expect(result.error).toBeInstanceOf(GlobalError);
			expect(result.error?.context.code).toBe(400);
			expect(result.error?.context.message).toContain("Validation failed");
		});

		it("should validate required fields", async () => {
			const node = defineNode({
				name: "required-node",
				description: "Required fields",
				input: z.object({
					required: z.string(),
					optional: z.string().optional(),
				}),
				output: z.object({ result: z.string() }),
				async execute(ctx, input) {
					return { result: input.required };
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { optional: "test" })) as IBlokResponse;

			expect(result.success).toBe(false);
			expect(result.error?.context.message).toContain("required");
		});

		it("should validate string formats (email, uuid, url)", async () => {
			const node = defineNode({
				name: "format-node",
				description: "Format validation",
				input: z.object({
					email: z.string().email(),
					id: z.string().uuid(),
					website: z.string().url(),
				}),
				output: z.object({ valid: z.boolean() }),
				async execute(ctx, input) {
					return { valid: true };
				},
			});

			const ctx = createTestContext();

			// Invalid email
			const emailResult = (await node.handle(ctx, {
				email: "invalid",
				id: "550e8400-e29b-41d4-a716-446655440000",
				website: "https://example.com",
			})) as IBlokResponse;
			expect(emailResult.success).toBe(false);

			// Invalid UUID
			const uuidResult = (await node.handle(ctx, {
				email: "test@example.com",
				id: "not-a-uuid",
				website: "https://example.com",
			})) as IBlokResponse;
			expect(uuidResult.success).toBe(false);

			// Invalid URL
			const urlResult = (await node.handle(ctx, {
				email: "test@example.com",
				id: "550e8400-e29b-41d4-a716-446655440000",
				website: "not-a-url",
			})) as IBlokResponse;
			expect(urlResult.success).toBe(false);

			// Valid input
			const validResult = (await node.handle(ctx, {
				email: "test@example.com",
				id: "550e8400-e29b-41d4-a716-446655440000",
				website: "https://example.com",
			})) as IBlokResponse;
			expect(validResult.success).toBe(true);
		});

		it("should validate number constraints (min, max, positive)", async () => {
			const node = defineNode({
				name: "number-node",
				description: "Number validation",
				input: z.object({
					age: z.number().int().positive().max(120),
					score: z.number().min(0).max(100),
				}),
				output: z.object({ valid: z.boolean() }),
				async execute(ctx, input) {
					return { valid: true };
				},
			});

			const ctx = createTestContext();

			// Negative age
			const negativeResult = (await node.handle(ctx, {
				age: -5,
				score: 50,
			})) as IBlokResponse;
			expect(negativeResult.success).toBe(false);

			// Age too high
			const tooHighResult = (await node.handle(ctx, {
				age: 150,
				score: 50,
			})) as IBlokResponse;
			expect(tooHighResult.success).toBe(false);

			// Score out of range
			const scoreResult = (await node.handle(ctx, {
				age: 30,
				score: 150,
			})) as IBlokResponse;
			expect(scoreResult.success).toBe(false);

			// Valid
			const validResult = (await node.handle(ctx, {
				age: 30,
				score: 85,
			})) as IBlokResponse;
			expect(validResult.success).toBe(true);
		});

		it("should validate array constraints", async () => {
			const node = defineNode({
				name: "array-node",
				description: "Array validation",
				input: z.object({
					tags: z.array(z.string()).min(1).max(5),
				}),
				output: z.object({ count: z.number() }),
				async execute(ctx, input) {
					return { count: input.tags.length };
				},
			});

			const ctx = createTestContext();

			// Empty array
			const emptyResult = (await node.handle(ctx, { tags: [] })) as IBlokResponse;
			expect(emptyResult.success).toBe(false);

			// Too many items
			const tooManyResult = (await node.handle(ctx, {
				tags: ["a", "b", "c", "d", "e", "f"],
			})) as IBlokResponse;
			expect(tooManyResult.success).toBe(false);

			// Valid
			const validResult = (await node.handle(ctx, { tags: ["a", "b"] })) as IBlokResponse;
			expect(validResult.success).toBe(true);
			expect(validResult.data).toEqual({ count: 2 });
		});

		it("should validate enums", async () => {
			const node = defineNode({
				name: "enum-node",
				description: "Enum validation",
				input: z.object({
					status: z.enum(["active", "inactive", "pending"]),
				}),
				output: z.object({ status: z.string() }),
				async execute(ctx, input) {
					return { status: input.status };
				},
			});

			const ctx = createTestContext();

			// Invalid enum value
			const invalidResult = (await node.handle(ctx, { status: "unknown" })) as IBlokResponse;
			expect(invalidResult.success).toBe(false);

			// Valid enum values
			for (const status of ["active", "inactive", "pending"]) {
				const result = (await node.handle(ctx, { status })) as IBlokResponse;
				expect(result.success).toBe(true);
				expect(result.data).toEqual({ status });
			}
		});

		it("should handle optional fields with defaults", async () => {
			const node = defineNode({
				name: "default-node",
				description: "Default values",
				input: z.object({
					required: z.string(),
					optional: z.string().optional(),
					withDefault: z.number().default(42),
				}),
				output: z.object({ value: z.number() }),
				async execute(ctx, input) {
					return { value: input.withDefault };
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { required: "test" })) as IBlokResponse;

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ value: 42 });
		});
	});

	describe("Output Validation", () => {
		it("should validate output and reject invalid return values", async () => {
			const node = defineNode({
				name: "output-validation-node",
				description: "Output validation",
				input: z.object({ value: z.number() }),
				output: z.object({
					result: z.number(),
					status: z.string(),
				}),
				async execute(ctx, input) {
					// Return invalid output (missing status field)
					return { result: input.value } as any;
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { value: 5 })) as IBlokResponse;

			expect(result.success).toBe(false);
			expect(result.error).toBeInstanceOf(GlobalError);
			expect(result.error?.context.message).toContain("Validation failed");
		});

		it("should validate output type constraints", async () => {
			const node = defineNode({
				name: "type-node",
				description: "Type validation",
				input: z.object({ value: z.number() }),
				output: z.object({
					email: z.string().email(),
				}),
				async execute(ctx, input) {
					// Return invalid email
					return { email: "not-an-email" };
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { value: 5 })) as IBlokResponse;

			expect(result.success).toBe(false);
			expect(result.error?.context.message).toContain("Validation failed");
		});

		it("should allow valid output", async () => {
			const node = defineNode({
				name: "valid-output-node",
				description: "Valid output",
				input: z.object({ value: z.number() }),
				output: z.object({
					result: z.number(),
					doubled: z.number(),
				}),
				async execute(ctx, input) {
					return {
						result: input.value,
						doubled: input.value * 2,
					};
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { value: 5 })) as IBlokResponse;

			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				result: 5,
				doubled: 10,
			});
		});
	});

	describe("Error Handling", () => {
		it("should handle execution errors and map to GlobalError", async () => {
			const node = defineNode({
				name: "error-node",
				description: "Throws error",
				input: z.object({ value: z.number() }),
				output: z.object({ result: z.number() }),
				async execute(ctx, input) {
					throw new Error("Something went wrong");
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { value: 5 })) as IBlokResponse;

			expect(result.success).toBe(false);
			expect(result.error).toBeInstanceOf(GlobalError);
			expect(result.error?.context.message).toBe("Something went wrong");
			expect(result.error?.context.code).toBe(500);
			expect(result.error?.context.name).toBe("error-node");
		});

		it("should include stack trace in error", async () => {
			const node = defineNode({
				name: "stack-node",
				description: "Stack trace",
				input: z.object({ value: z.number() }),
				output: z.object({ result: z.number() }),
				async execute(ctx, input) {
					throw new Error("Test error");
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { value: 5 })) as IBlokResponse;

			expect(result.error?.context.stack).toBeDefined();
			expect(result.error?.context.stack).toContain("Error: Test error");
		});

		it("should handle non-Error objects thrown", async () => {
			const node = defineNode({
				name: "non-error-node",
				description: "Throws non-Error",
				input: z.object({ value: z.number() }),
				output: z.object({ result: z.number() }),
				async execute(ctx, input) {
					throw "String error";
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, { value: 5 })) as IBlokResponse;

			expect(result.success).toBe(false);
			expect(result.error?.context.message).toBe("String error");
		});

		it("should include validation errors in error JSON", async () => {
			const node = defineNode({
				name: "validation-error-node",
				description: "Validation error details",
				input: z.object({
					email: z.string().email(),
					age: z.number().positive(),
				}),
				output: z.object({ valid: z.boolean() }),
				async execute(ctx, input) {
					return { valid: true };
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, {
				email: "invalid",
				age: -5,
			})) as IBlokResponse;

			expect(result.error?.context.code).toBe(400);
			expect(result.error?.hasJson()).toBe(true);
			expect(result.error?.context.json).toHaveProperty("validation_errors");
			const errors = result.error?.context.json?.validation_errors as unknown as unknown[];
			expect(Array.isArray(errors)).toBe(true);
			expect(errors.length).toBeGreaterThan(0);
		});
	});

	describe("Type Safety", () => {
		it("should infer input types correctly", async () => {
			const node = defineNode({
				name: "type-safe-node",
				description: "Type inference test",
				input: z.object({
					userId: z.string().uuid(),
					count: z.number().int(),
					optional: z.string().optional(),
				}),
				output: z.object({ result: z.string() }),
				async execute(ctx, input) {
					// TypeScript should know the exact types here
					const userId: string = input.userId;
					const count: number = input.count;
					// Type assertion only — confirms TypeScript inferred `optional` correctly.
					const _optional: string | undefined = input.optional;
					void _optional;

					return { result: `${userId}-${count}` };
				},
			});

			const ctx = createTestContext();
			const result = (await node.handle(ctx, {
				userId: "550e8400-e29b-41d4-a716-446655440000",
				count: 42,
			})) as IBlokResponse;

			expect(result.success).toBe(true);
		});
	});

	describe("Backward Compatibility", () => {
		it("should extend BlokService", () => {
			const node = defineNode({
				name: "compat-node",
				description: "Compatibility test",
				input: z.object({ value: z.number() }),
				output: z.object({ result: z.number() }),
				async execute(ctx, input) {
					return { result: input.value };
				},
			});

			// FunctionNode should be a BlokService
			expect(node).toHaveProperty("handle");
			expect(node).toHaveProperty("run");
			expect(node).toHaveProperty("inputSchema");
			expect(node).toHaveProperty("outputSchema");
		});

		it("should work with existing runner infrastructure", async () => {
			const node = defineNode({
				name: "runner-compat-node",
				description: "Runner compatibility",
				input: z.object({ value: z.number() }),
				output: z.object({ result: z.number() }),
				async execute(ctx, input) {
					return { result: input.value * 2 };
				},
			});

			// The node should have the handle() method that Runner expects
			const ctx = createTestContext();
			const result = (await node.handle(ctx, { value: 5 })) as IBlokResponse;

			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("data");
			expect(result).toHaveProperty("error");
		});
	});

	describe("Flow Nodes (definition.flow === true)", () => {
		it("returns the sub-step array directly when flow:true with non-empty result", async () => {
			const child = defineNode({
				name: "child",
				description: "child step",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				async execute() {
					return { ok: true };
				},
			});

			const flowNode = defineNode({
				name: "router",
				description: "flow router",
				flow: true,
				input: z.array(z.unknown()),
				output: z.array(z.unknown()),
				async execute() {
					return [child] as unknown as { ok: boolean }[];
				},
			});

			const ctx = createTestContext();
			const result = await flowNode.handle(ctx, []);
			expect(Array.isArray(result)).toBe(true);
			expect((result as unknown[]).length).toBe(1);
			expect("success" in (result as object)).toBe(false);
		});

		it("returns an empty array directly when flow:true (regression: empty branch arms)", async () => {
			// Reproduces the scaffold's empty.ts load-test stub:
			// branch({ when: ..., then: [], else: [] }) — both arms empty.
			// Pre-fix, defineNode wrapped [] as a BlokResponse, which the
			// runner's flow path then tried to spread → "Spread syntax requires
			// iterable" at RunnerSteps.ts.
			const flowNode = defineNode({
				name: "empty-router",
				description: "flow router with empty arms",
				flow: true,
				input: z.array(z.unknown()),
				output: z.array(z.unknown()),
				async execute() {
					return [] as unknown[];
				},
			});

			const ctx = createTestContext();
			const result = await flowNode.handle(ctx, []);
			expect(Array.isArray(result)).toBe(true);
			expect((result as unknown[]).length).toBe(0);
			expect("success" in (result as object)).toBe(false);
			expect("data" in (result as object)).toBe(false);
		});

		it("flow node returning a non-array fails the run with a clear error", async () => {
			const flowNode = defineNode({
				name: "bad-flow",
				description: "flow node returning non-array",
				flow: true,
				input: z.array(z.unknown()),
				output: z.unknown(),
				async execute() {
					return "not an array" as unknown as never[];
				},
			});

			const ctx = createTestContext();
			const result = await flowNode.handle(ctx, []);
			// Throws inside handle() → caught and routed through
			// mapErrorToGlobalError; surfaces as success:false response.
			expect(Array.isArray(result)).toBe(false);
			const wrapped = result as { success?: boolean; error?: { message?: string } };
			expect(wrapped.success).toBe(false);
			expect(wrapped.error?.message).toContain('Flow node "bad-flow"');
			expect(wrapped.error?.message).toContain("must return an array");
		});
	});
});
