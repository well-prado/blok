import { beforeEach, describe, expect, it, vi } from "vitest";
import type Context from "../../../src/types/Context";
import mapper from "../../../src/utils/Mapper";

function createMockContext(overrides: Partial<Context> = {}): Context {
	return {
		id: "test-id",
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
	} as Context;
}

describe("Mapper", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("replaceString()", () => {
		it("should replace ${key} with data value", () => {
			const ctx = createMockContext();
			const data = { name: "John" };
			const result = mapper.replaceString("Hello ${name}", ctx, data);
			expect(result).toBe("Hello John");
		});

		it("should replace multiple placeholders", () => {
			const ctx = createMockContext();
			const data = { first: "John", last: "Doe" };
			const result = mapper.replaceString("${first} ${last}", ctx, data);
			expect(result).toBe("John Doe");
		});

		it("should handle nested data access via lodash.get", () => {
			const ctx = createMockContext();
			const data = { user: { name: "Alice" } };
			const result = mapper.replaceString("Hi ${user.name}", ctx, data);
			expect(result).toBe("Hi Alice");
		});

		it("should handle no matches (no ${})", () => {
			const ctx = createMockContext();
			const result = mapper.replaceString("plain text", ctx, {});
			expect(result).toBe("plain text");
		});

		it("should execute js/ prefix expressions", () => {
			const ctx = createMockContext();
			const result = mapper.replaceString("js/1 + 2", ctx, {});
			expect(result).toBe(3);
		});

		it("should pass through non-js strings", () => {
			const ctx = createMockContext();
			const result = mapper.replaceString("hello world", ctx, {});
			expect(result).toBe("hello world");
		});

		it("should handle errors silently in placeholder replacement", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const ctx = createMockContext();
			// An expression that throws inside Function()
			const result = mapper.replaceString("${undefinedVar.deep.access}", ctx, {});
			// Should not throw, returns string with attempted replacement
			expect(result).toBeTypeOf("string");
			consoleSpy.mockRestore();
		});
	});

	describe("replaceObjectStrings()", () => {
		it("should replace string values in flat object", () => {
			const ctx = createMockContext();
			const data = { greeting: "World" };
			const obj: Record<string, unknown> = { msg: "Hello ${greeting}" };
			mapper.replaceObjectStrings(obj, ctx, data);
			expect(obj.msg).toBe("Hello World");
		});

		it("should recursively replace nested objects", () => {
			const ctx = createMockContext();
			const data = { val: "replaced" };
			const obj: Record<string, unknown> = {
				level1: {
					level2: "value is ${val}",
				},
			};
			mapper.replaceObjectStrings(obj, ctx, data);
			expect((obj.level1 as Record<string, unknown>).level2).toBe("value is replaced");
		});

		it("should skip non-string, non-object values", () => {
			const ctx = createMockContext();
			const obj: Record<string, unknown> = { num: 42, bool: true, str: "keep" };
			mapper.replaceObjectStrings(obj, ctx, {});
			expect(obj.num).toBe(42);
			expect(obj.bool).toBe(true);
			expect(obj.str).toBe("keep");
		});
	});

	describe("jsMapper via replaceString", () => {
		it("should access ctx in js/ expressions", () => {
			const ctx = createMockContext({ vars: { count: 5 } });
			const result = mapper.replaceString("js/ctx.vars.count", ctx, {});
			expect(result).toBe(5);
		});

		it("should handle js/ errors silently", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const ctx = createMockContext();
			const result = mapper.replaceString('js/throw new Error("fail")', ctx, {});
			// Should return the original string on error
			expect(result).toBe('js/throw new Error("fail")');
			consoleSpy.mockRestore();
		});
	});
});
