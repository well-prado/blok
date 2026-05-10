import { beforeEach, describe, expect, it, vi } from "vitest";
import GlobalError from "../../src/GlobalError";
import NodeBase from "../../src/NodeBase";
import type Context from "../../src/types/Context";
import type ResponseContext from "../../src/types/ResponseContext";

class TestNode extends NodeBase {
	public mockResponse: ResponseContext = { data: { result: "ok" }, error: null, success: true };
	public runCalls: Context[] = [];

	async run(ctx: Context): Promise<ResponseContext> {
		this.runCalls.push(ctx);
		return this.mockResponse;
	}
}

// Loose `Record<string, unknown>` overrides so tests can pass shapes that
// don't strictly match `Partial<Context>` (e.g. `config: { "<node>": ... }`,
// which is the runtime layout but isn't reflected in the typed `ConfigContext`).
function createTestContext(overrides: Record<string, unknown> = {}): Context {
	return {
		id: "test-ctx",
		request: { body: {}, headers: {}, query: {}, params: {} },
		response: { data: null, error: null, success: true },
		error: { message: "" },
		logger: { log: vi.fn(), logLevel: vi.fn(), error: vi.fn() },
		config: {},
		func: {},
		vars: {},
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	} as unknown as Context;
}

describe("NodeBase", () => {
	let node: TestNode;

	beforeEach(() => {
		node = new TestNode();
		node.name = "test-node";
		vi.restoreAllMocks();
	});

	describe("default properties", () => {
		it("should have correct defaults", () => {
			const n = new TestNode();
			expect(n.flow).toBe(false);
			expect(n.name).toBe("");
			expect(n.active).toBe(true);
			expect(n.stop).toBe(false);
			// set_var defaults to undefined (NOT false). false short-circuits
			// PersistenceHelper.applyStepOutput and silently disables v2's
			// default-store rule for every step that didn't explicitly set it.
			expect(n.set_var).toBeUndefined();
			expect(n.contentType).toBe("");
		});
	});

	describe("process()", () => {
		it("should call run() and return response", async () => {
			const ctx = createTestContext({
				config: { "test-node": { param: "value" } },
			});

			const response = await node.process(ctx);
			expect(response).toEqual(node.mockResponse);
			expect(node.runCalls).toHaveLength(1);
		});

		it("should clone config for originalConfig", async () => {
			const configData = { key: "val" };
			const ctx = createTestContext({
				config: { "test-node": configData },
			});

			await node.process(ctx);
			expect(node.originalConfig).toEqual(configData);
			// Should be a deep clone, not same reference
			expect(node.originalConfig).not.toBe(configData);
		});

		it("should set ctx.response on success", async () => {
			const ctx = createTestContext({
				config: { "test-node": {} },
			});

			await node.process(ctx);
			expect(ctx.response).toEqual(node.mockResponse);
		});

		it("should throw when response has error", async () => {
			const error = new GlobalError("process error");
			node.mockResponse = { data: null, error, success: false };

			const ctx = createTestContext({
				config: { "test-node": {} },
			});

			await expect(node.process(ctx)).rejects.toBe(error);
		});
	});

	describe("processFlow()", () => {
		it("should call run() and return response", async () => {
			const ctx = createTestContext({
				config: { "test-node": {} },
			});

			const response = await node.processFlow(ctx);
			expect(response).toEqual(node.mockResponse);
		});

		it("should catch errors and wrap in setError", async () => {
			const testNode = new TestNode();
			testNode.name = "error-node";
			testNode.run = vi.fn().mockRejectedValue({ message: "oops" });

			const ctx = createTestContext({
				config: { "error-node": {} },
			});

			const response = await testNode.processFlow(ctx);
			expect(response.success).toBe(false);
			expect(response.error).toBeInstanceOf(GlobalError);
		});

		it("should set ctx.response on error", async () => {
			const testNode = new TestNode();
			testNode.name = "error-node";
			testNode.run = vi.fn().mockRejectedValue({ message: "fail" });

			const ctx = createTestContext({
				config: { "error-node": {} },
			});

			await testNode.processFlow(ctx);
			expect(ctx.response.success).toBe(false);
			expect(ctx.response.error).toBeInstanceOf(GlobalError);
		});
	});

	describe("runSteps()", () => {
		it('should throw "not implemented" error', () => {
			const ctx = createTestContext();
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			expect(() => node.runSteps([], ctx)).toThrow("runSteps method is not implemented.");
			consoleSpy.mockRestore();
		});
	});

	describe("runJs()", () => {
		it("should evaluate simple expressions", () => {
			const ctx = createTestContext();
			const result = node.runJs("1 + 2", ctx);
			expect(result).toBe(3);
		});

		it("should access ctx parameter", () => {
			const ctx = createTestContext({ id: "my-id" });
			const result = node.runJs("ctx.id", ctx);
			expect(result).toBe("my-id");
		});

		it("should access data parameter", () => {
			const ctx = createTestContext();
			const result = node.runJs("data.x", ctx, { x: 42 } as unknown as Record<string, string>);
			expect(result).toBe(42);
		});

		it("should access vars parameter", () => {
			const ctx = createTestContext();
			const result = node.runJs("vars.count", ctx, {}, {}, { count: 10 });
			expect(result).toBe(10);
		});

		it("should handle string concatenation", () => {
			const ctx = createTestContext();
			const result = node.runJs('"hello" + " " + "world"', ctx);
			expect(result).toBe("hello world");
		});
	});

	describe("setVar()", () => {
		it("should initialize ctx.vars if undefined", () => {
			const ctx = createTestContext();
			ctx.vars = undefined;
			node.setVar(ctx, { key: "value" });
			expect(ctx.vars).toEqual({ key: "value" });
		});

		it("should merge vars into ctx.vars", () => {
			const ctx = createTestContext({ vars: { existing: "keep" } });
			node.setVar(ctx, { newKey: "newVal" });
			expect(ctx.vars).toEqual({ existing: "keep", newKey: "newVal" });
		});
	});

	describe("getVar()", () => {
		it("should return value by name", () => {
			const ctx = createTestContext({ vars: { myVar: "found" } });
			expect(node.getVar(ctx, "myVar")).toBe("found");
		});

		it("should return undefined for missing var", () => {
			const ctx = createTestContext({ vars: { a: 1 } });
			expect(node.getVar(ctx, "nonexistent")).toBeUndefined();
		});

		it("should handle undefined ctx.vars", () => {
			const ctx = createTestContext();
			ctx.vars = undefined;
			expect(node.getVar(ctx, "any")).toBeUndefined();
		});
	});

	describe("blueprintMapper()", () => {
		it("should handle string input", () => {
			const ctx = createTestContext();
			const result = node.blueprintMapper("plain text" as unknown as Record<string, string>, ctx);
			expect(result).toBe("plain text");
		});

		it("should handle object input without error", () => {
			const ctx = createTestContext();
			const obj = { key: "value" };
			const result = node.blueprintMapper(obj, ctx);
			expect(result).toEqual(obj);
		});

		it("should catch and log mapper errors", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const ctx = createTestContext();
			// null will cause mapper to fail
			const result = node.blueprintMapper(null as unknown as Record<string, string>, ctx);
			// Should not throw
			expect(result).toBeNull();
			consoleSpy.mockRestore();
		});
	});

	describe("setError()", () => {
		it("should create GlobalError from string", () => {
			const error = node.setError("simple error" as unknown as any);
			expect(error).toBeInstanceOf(GlobalError);
			expect(error.message).toBe("simple error");
		});

		it("should create GlobalError from {message} only", () => {
			const error = node.setError({ message: "just a message" });
			expect(error).toBeInstanceOf(GlobalError);
			expect(error.message).toBe("just a message");
		});

		it("should create GlobalError from object with multiple keys", () => {
			const config = { message: "error", detail: "extra info" };
			const error = node.setError(config as any);
			expect(error).toBeInstanceOf(GlobalError);
			expect(error.hasJson()).toBe(true);
		});

		it("should set json when config has json field", () => {
			const config = { message: "err", json: { detail: "info" } };
			const error = node.setError(config as any);
			expect(error.hasJson()).toBe(true);
		});

		it("should set stack when config has stack field", () => {
			const config = { message: "err", stack: "Error\n  at line 1" };
			const error = node.setError(config);
			expect(error.context.stack).toBe("Error\n  at line 1");
		});

		it("should set numeric code from config", () => {
			const config = { message: "err", code: 404 };
			const error = node.setError(config);
			expect(error.context.code).toBe(404);
		});

		it("should default to 500 for non-numeric code", () => {
			const config = { message: "err", code: "bad" as unknown as number };
			const error = node.setError(config);
			expect(error.context.code).toBe(500);
		});

		it("should set name from this.name", () => {
			const error = node.setError({ message: "err" });
			expect(error.context.name).toBe("test-node");
		});
	});
});
