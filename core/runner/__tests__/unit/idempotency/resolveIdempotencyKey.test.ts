import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { resolveIdempotencyKey } from "../../../src/idempotency/resolveIdempotencyKey";

function makeCtx(overrides: Partial<Context> = {}): Context {
	return {
		id: "test",
		workflow_name: "wf",
		workflow_path: "/wf",
		request: {
			body: { requestId: "req-abc-123" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	};
}

describe("resolveIdempotencyKey", () => {
	it("returns null when the key is undefined", () => {
		expect(resolveIdempotencyKey(undefined, makeCtx())).toBeNull();
	});

	it("returns null when the key is an empty string", () => {
		expect(resolveIdempotencyKey("", makeCtx())).toBeNull();
	});

	it("returns the literal string when the key has no js/ prefix", () => {
		expect(resolveIdempotencyKey("user-123", makeCtx())).toBe("user-123");
	});

	it("evaluates a js/ expression against the live ctx", () => {
		expect(resolveIdempotencyKey("js/ctx.request.body.requestId", makeCtx())).toBe("req-abc-123");
	});

	it("coerces non-string evaluation results to strings", () => {
		const ctx = makeCtx({
			request: {
				body: { count: 42 },
				headers: {},
				params: {},
				query: {},
			} as unknown as Context["request"],
		});
		expect(resolveIdempotencyKey("js/ctx.request.body.count", ctx)).toBe("42");
	});

	it("returns null when the expression resolves to undefined", () => {
		expect(resolveIdempotencyKey("js/ctx.request.body.missing", makeCtx())).toBeNull();
	});

	it("returns null when the expression resolves to null", () => {
		const ctx = makeCtx({
			request: {
				body: { value: null },
				headers: {},
				params: {},
				query: {},
			} as unknown as Context["request"],
		});
		expect(resolveIdempotencyKey("js/ctx.request.body.value", ctx)).toBeNull();
	});

	it("returns null on a thrown evaluation (cache miss, step still runs)", () => {
		// Accessing a property on undefined throws; the helper must not propagate.
		expect(resolveIdempotencyKey("js/ctx.nonexistent.foo.bar", makeCtx())).toBeNull();
	});

	it("returns null on a syntactically invalid expression", () => {
		expect(resolveIdempotencyKey("js/ctx.request.body.+", makeCtx())).toBeNull();
	});
});
