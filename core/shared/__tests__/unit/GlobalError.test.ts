import { describe, expect, it } from "vitest";
import GlobalError from "../../src/GlobalError";

describe("GlobalError", () => {
	describe("constructor", () => {
		it("should create error with message string", () => {
			const error = new GlobalError("test error");
			expect(error.message).toBe("test error");
			expect(error.context.message).toBe("test error");
		});

		it("should extend Error", () => {
			const error = new GlobalError("test");
			expect(error).toBeInstanceOf(Error);
		});

		it("should set prototype correctly for instanceof", () => {
			const error = new GlobalError("test");
			expect(error).toBeInstanceOf(GlobalError);
		});

		it("should handle undefined message", () => {
			const error = new GlobalError(undefined);
			expect(error.context.message).toBeUndefined();
		});
	});

	describe("setCode", () => {
		it("should set code on context", () => {
			const error = new GlobalError("test");
			error.setCode(404);
			expect(error.context.code).toBe(404);
		});

		it("should handle undefined code", () => {
			const error = new GlobalError("test");
			error.setCode(undefined);
			expect(error.context.code).toBeUndefined();
		});
	});

	describe("setJson", () => {
		it("should set json on context", () => {
			const json = { key: "value" };
			const error = new GlobalError("test");
			error.setJson(json);
			expect(error.context.json).toEqual(json);
		});
	});

	describe("setStack", () => {
		it("should set stack on context", () => {
			const error = new GlobalError("test");
			error.setStack("Error\n  at test.ts:1");
			expect(error.context.stack).toBe("Error\n  at test.ts:1");
		});
	});

	describe("setName", () => {
		it("should set name on context", () => {
			const error = new GlobalError("test");
			error.setName("my-node");
			expect(error.context.name).toBe("my-node");
		});
	});

	describe("hasJson", () => {
		it("should return false when no json set", () => {
			const error = new GlobalError("test");
			expect(error.hasJson()).toBe(false);
		});

		it("should return true when json is set", () => {
			const error = new GlobalError("test");
			error.setJson({ key: "value" });
			expect(error.hasJson()).toBe(true);
		});
	});

	describe("toString", () => {
		it("should return JSON string when json is set", () => {
			const error = new GlobalError("test");
			const json = { key: "value" };
			error.setJson(json);
			expect(error.toString()).toBe(JSON.stringify(json));
		});

		it("should return message string when no json", () => {
			const error = new GlobalError("test error");
			expect(error.toString()).toBe("test error");
		});
	});
});
