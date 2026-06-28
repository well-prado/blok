import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Context from "../../../src/types/Context";
import type ParamsDictionary from "../../../src/types/ParamsDictionary";
// The REAL Mapper — not a mock. The whole point of #415 is to prove the
// lowering pass produces strings the SHIPPED engine resolves end-to-end.
import mapper from "../../../src/utils/Mapper";
import { lowerRefs } from "../../../src/utils/lowerRefs";

/**
 * #415 — Lock ADR 0001 Option C against the real Mapper.
 *
 * 1. FALSIFICATION (the RED test): vanilla `replaceObjectStrings` does NOT
 *    resolve a raw `{$ref}` today — it walks INTO the plain object and
 *    string-resolves the inner step/path fields. This is exactly why the
 *    lowering pass is REQUIRED (ADR 0001 probe S1).
 * 2. lowerRefs produces the exact `js/ctx.state...` wire strings.
 * 3. The lowered IR resolves end-to-end through the real Mapper against a
 *    populated ctx (ADR 0001 probe S3).
 */

function createCtx(state: Record<string, unknown>): Context {
	return {
		state,
		workflow_name: "lowerRefs-test",
		request: { body: {}, headers: {}, query: {}, params: {} },
		response: { data: null, error: null, success: true },
		config: {},
		func: {},
		vars: {},
	} as unknown as Context;
}

const POPULATED_STATE = {
	validate: { productId: "P-123", qty: 4, free: 0, ok: false, label: "" },
	checkStock: { inStock: true },
	tags: ["a", "b", "c"],
};

describe("lowerRefs — ADR 0001 Option C load-boundary lowering", () => {
	beforeEach(() => {
		// strict default — a lowered string that fails to resolve should throw,
		// making any lowering bug loud rather than silently passing through.
		process.env.BLOK_MAPPER_MODE = undefined;
	});
	afterEach(() => {
		process.env.BLOK_MAPPER_MODE = undefined;
	});

	// =========================================================================
	// 1. FALSIFICATION — proves the pass is REQUIRED
	// =========================================================================

	describe("falsification — the real Mapper does NOT resolve a raw {$ref}", () => {
		it("leaves a raw {$ref} unresolved (string-resolves the inner fields instead)", () => {
			const ctx = createCtx({ price: { total: 42 } });
			const input: ParamsDictionary = {
				amount: { $ref: { step: "price", path: ["total"] } },
			} as unknown as ParamsDictionary;

			mapper.replaceObjectStrings(input, ctx, ctx as unknown as ParamsDictionary);

			// Still the structural object — never resolved to 42. The Mapper
			// recursed INTO it; `step`/`path` are plain strings/array so they
			// pass through untouched. This documents the verified gap.
			expect((input as Record<string, unknown>).amount).toEqual({
				$ref: { step: "price", path: ["total"] },
			});
			expect((input as Record<string, unknown>).amount).not.toBe(42);
		});
	});

	// =========================================================================
	// 2. lowerRefs produces the exact wire strings
	// =========================================================================

	describe("lowering — {$ref} → js/ctx.state.<root> + path", () => {
		it("field ref: string path segment → .seg", () => {
			expect(lowerRefs({ url: { $ref: { step: "validate", path: ["productId"] } } })).toEqual({
				url: "js/ctx.state.validate.productId",
			});
		});

		it("whole-output ref: empty path [] → js/ctx.state.<root>", () => {
			expect(lowerRefs({ whole: { $ref: { step: "validate", path: [] } } })).toEqual({
				whole: "js/ctx.state.validate",
			});
		});

		it("whole-output ref: omitted path → js/ctx.state.<root>", () => {
			expect(lowerRefs({ whole: { $ref: { step: "validate" } } })).toEqual({
				whole: "js/ctx.state.validate",
			});
		});

		it("array-index path: numeric segment → [n]", () => {
			expect(lowerRefs({ tag: { $ref: { step: "tags", path: [1] } } })).toEqual({
				tag: "js/ctx.state.tags[1]",
			});
		});

		it("mixed path: object key then array index then key", () => {
			expect(lowerRefs({ x: { $ref: { step: "s", path: ["a", 0, "b"] } } })).toEqual({
				x: "js/ctx.state.s.a[0].b",
			});
		});

		it("ref nested in an array — siblings preserved", () => {
			expect(lowerRefs({ list: [{ $ref: { step: "validate", path: ["qty"] } }, "static"] })).toEqual({
				list: ["js/ctx.state.validate.qty", "static"],
			});
		});

		it("ref nested in a plain object", () => {
			expect(lowerRefs({ nested: { inner: { $ref: { step: "checkStock", path: ["inStock"] } } } })).toEqual({
				nested: { inner: "js/ctx.state.checkStock.inStock" },
			});
		});

		it("is pure — does not mutate the input", () => {
			const input = { url: { $ref: { step: "validate", path: ["productId"] } } };
			const snapshot = JSON.parse(JSON.stringify(input));
			lowerRefs(input);
			expect(input).toEqual(snapshot);
		});
	});

	// =========================================================================
	// 3. Sentinel guard — only the {$ref} shape is treated as a ref
	// =========================================================================

	describe("sentinel reservation — non-{$ref} data passes through untouched", () => {
		it("an object with literal step/path keys is NOT a ref (multi-key)", () => {
			const input = { config: { step: "validate", path: ["x"], extra: 1 } };
			expect(lowerRefs(input)).toEqual(input);
		});

		it("a $ref whose .step is not a string is NOT a ref", () => {
			const input = { weird: { $ref: { step: 42, path: [] } } };
			expect(lowerRefs(input)).toEqual(input);
		});

		it("a $ref alongside other keys is NOT the sentinel (multi-key)", () => {
			const input = { weird: { $ref: { step: "s" }, other: 1 } };
			expect(lowerRefs(input)).toEqual(input);
		});

		it("primitives and missing values pass through", () => {
			expect(lowerRefs({ a: 1, b: "str", c: true, d: null })).toEqual({
				a: 1,
				b: "str",
				c: true,
				d: null,
			});
		});
	});

	// =========================================================================
	// 4. END-TO-END — lowered IR resolves through the REAL Mapper
	// =========================================================================

	describe("end-to-end — lower then resolve through the real Mapper", () => {
		it("field / whole-output / array / nested all resolve against a populated ctx", () => {
			const ctx = createCtx(POPULATED_STATE);
			const lowered = lowerRefs({
				url: { $ref: { step: "validate", path: ["productId"] } },
				whole: { $ref: { step: "validate", path: [] } },
				list: [{ $ref: { step: "validate", path: ["qty"] } }, "static"],
				nested: { inner: { $ref: { step: "checkStock", path: ["inStock"] } } },
			}) as unknown as ParamsDictionary;

			mapper.replaceObjectStrings(lowered, ctx, ctx as unknown as ParamsDictionary);

			const out = lowered as Record<string, unknown>;
			expect(out.url).toBe("P-123");
			expect(out.whole).toEqual(POPULATED_STATE.validate); // whole-output ref
			expect(out.list).toEqual([4, "static"]); // array index, type-preserved
			expect(typeof (out.list as unknown[])[0]).toBe("number");
			expect(out.nested).toEqual({ inner: true }); // nested object, boolean preserved
		});

		it("falsy resolved values are preserved (0 / false / '') — not dropped", () => {
			const ctx = createCtx(POPULATED_STATE);
			const lowered = lowerRefs({
				zero: { $ref: { step: "validate", path: ["free"] } },
				flag: { $ref: { step: "validate", path: ["ok"] } },
				empty: { $ref: { step: "validate", path: ["label"] } },
			}) as unknown as ParamsDictionary;

			mapper.replaceObjectStrings(lowered, ctx, ctx as unknown as ParamsDictionary);

			const out = lowered as Record<string, unknown>;
			expect(out.zero).toBe(0);
			expect(out.flag).toBe(false);
			expect(out.empty).toBe("");
		});

		it("ref to a missing step → undefined (not a throw), even in strict mode", () => {
			process.env.BLOK_MAPPER_MODE = "strict";
			const ctx = createCtx(POPULATED_STATE);
			const lowered = lowerRefs({
				gone: { $ref: { step: "neverRan", path: [] } },
			}) as unknown as ParamsDictionary;

			// Whole-output ref to a step that never ran: `ctx.state.neverRan`
			// is undefined — a valid value, not an eval error — so it must NOT
			// throw. (A field ref like `ctx.state.neverRan.x` WOULD throw in
			// strict mode, which is the correct fail-fast behavior; that's the
			// Mapper's contract, not the lowering pass's.)
			expect(() => mapper.replaceObjectStrings(lowered, ctx, ctx as unknown as ParamsDictionary)).not.toThrow();
			expect((lowered as Record<string, unknown>).gone).toBeUndefined();
		});
	});
});
