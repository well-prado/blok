import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import {
	UnresolvableKeyExpressionError,
	resolveConcurrencyKey,
	resolveIdempotencyKey,
} from "../../../src/idempotency/resolveIdempotencyKey";

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

/**
 * #706 — the resolver used to take ANY non-`js/` string as a literal key, so a
 * mistyped expression became a CONSTANT: one idempotency-cache entry replayed to
 * every caller for the full TTL, one concurrency bucket for every tenant. These
 * are the shapes authors actually wrote in the shipped corpus and in the docs.
 */
describe("resolveIdempotencyKey — expression-shaped keys never degrade to constants (#706)", () => {
	const shapes: Array<[label: string, key: unknown]> = [
		["$. proxy path", "$.req.body.requestId"],
		["bare ctx. expression", "ctx.request.body.requestId"],
		["${…} interpolation", "order-${ctx.request.body.requestId}"],
		["{{…}} template", "{{ctx.request.body.requestId}}"],
		["unlowered {$ref} object", { $ref: { step: "@trigger", path: ["body", "requestId"] } }],
		["unlowered {$tpl} object", { $tpl: ["order-", { $ref: { step: "@trigger", path: ["body", "id"] } }] }],
	];

	for (const [label, key] of shapes) {
		it(`throws UnresolvableKeyExpressionError for ${label}`, () => {
			expect(() => resolveIdempotencyKey(key, makeCtx())).toThrow(UnresolvableKeyExpressionError);
		});
	}

	it("names the field, the location and the fix in the message", () => {
		let caught: unknown;
		try {
			resolveIdempotencyKey("$.req.body.requestId", makeCtx(), { field: "idempotencyKey", where: 'step "charge"' });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(UnresolvableKeyExpressionError);
		const message = (caught as Error).message;
		expect(message).toContain("idempotencyKey");
		expect(message).toContain('step "charge"');
		expect(message).toContain("js/");
		expect((caught as Error).name).toBe("UnresolvableKeyExpressionError");
	});

	it("the concurrency variant throws too — one guard covers both call sites", () => {
		expect(() => resolveConcurrencyKey("$.req.body.tenant", makeCtx())).toThrow(UnresolvableKeyExpressionError);
	});

	// The whole point of NOT rejecting every non-`js/` string: a static dedup key
	// is a legitimate, documented use.
	it("leaves genuine literal keys alone", () => {
		for (const literal of ["user-123", "daily-report", "nightly:2026-08-07", "sha256$abc", "a{b}c"]) {
			expect(resolveIdempotencyKey(literal, makeCtx())).toBe(literal);
		}
	});
});
