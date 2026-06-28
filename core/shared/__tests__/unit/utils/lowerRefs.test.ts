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
	// 2b. Non-identifier step ids AND path keys → bracket-quoted form
	//     (regression for the two HIGH bugs: a dash-named step id like
	//     "fan-out" must NOT lower to the INVALID `js/ctx.state.fan-out`, and
	//     a dash/dot/space/leading-digit path key must bracket-quote too.)
	// =========================================================================

	describe("non-identifier roots & keys → bracket-quoted (mirror $.ts)", () => {
		it("dash-named step id (root): fan-out → js/ctx.state['fan-out']", () => {
			expect(lowerRefs({ x: { $ref: { step: "fan-out", path: ["id"] } } })).toEqual({
				x: 'js/ctx.state["fan-out"].id',
			});
		});

		it("dash-named step id, whole-output ref: send-receipt → js/ctx.state['send-receipt']", () => {
			expect(lowerRefs({ x: { $ref: { step: "send-receipt", path: [] } } })).toEqual({
				x: 'js/ctx.state["send-receipt"]',
			});
		});

		it("dotted step id (root): a.b → bracket-quoted", () => {
			expect(lowerRefs({ x: { $ref: { step: "a.b", path: ["c"] } } })).toEqual({
				x: 'js/ctx.state["a.b"].c',
			});
		});

		it("leading-digit step id (root): 1step → bracket-quoted", () => {
			expect(lowerRefs({ x: { $ref: { step: "1step", path: [] } } })).toEqual({
				x: 'js/ctx.state["1step"]',
			});
		});

		it("identifier root stays dotted: fanOut → js/ctx.state.fanOut", () => {
			expect(lowerRefs({ x: { $ref: { step: "fanOut", path: [] } } })).toEqual({
				x: "js/ctx.state.fanOut",
			});
		});

		it("dash-named PATH key: bracket-quoted suffix", () => {
			expect(lowerRefs({ x: { $ref: { step: "validate", path: ["user-id"] } } })).toEqual({
				x: 'js/ctx.state.validate["user-id"]',
			});
		});

		it("dotted + space + leading-digit path keys all bracket-quote", () => {
			expect(lowerRefs({ x: { $ref: { step: "validate", path: ["a.b", "has space", "0key"] } } })).toEqual({
				x: 'js/ctx.state.validate["a.b"]["has space"]["0key"]',
			});
		});

		it("end-to-end: dash-named root + dash-named key resolve through the REAL Mapper", () => {
			const ctx = createCtx({
				"fan-out": { "user-id": "U-9", count: 0 },
				"send-receipt": { ok: false },
			});
			const lowered = lowerRefs({
				uid: { $ref: { step: "fan-out", path: ["user-id"] } },
				zero: { $ref: { step: "fan-out", path: ["count"] } },
				whole: { $ref: { step: "send-receipt", path: [] } },
			}) as unknown as ParamsDictionary;

			mapper.replaceObjectStrings(lowered, ctx, ctx as unknown as ParamsDictionary);

			const out = lowered as Record<string, unknown>;
			expect(out.uid).toBe("U-9");
			expect(out.zero).toBe(0); // falsy preserved
			expect(out.whole).toEqual({ ok: false }); // whole-output ref to dash-named step
		});
	});

	// =========================================================================
	// 2c. TRIGGER-ROOT branch — a ref rooted at the `@trigger` pseudo-step
	//     lowers to `js/ctx.request` (the trigger payload), NOT
	//     `js/ctx.state["@trigger"]`. The runner never writes
	//     ctx.state["@trigger"]; createContext leaves ctx.state = {} and puts
	//     the payload at ctx.request. (Blocker fix for the callback workflow()
	//     trigger-input leg — issue #421 / PR #472.)
	// =========================================================================

	describe("trigger-root — {$ref step:'@trigger'} → js/ctx.request + path", () => {
		it("field ref: req.body.name → js/ctx.request.body.name", () => {
			expect(lowerRefs({ name: { $ref: { step: "@trigger", path: ["body", "name"] } } })).toEqual({
				name: "js/ctx.request.body.name",
			});
		});

		it("whole-payload ref: empty path → js/ctx.request", () => {
			expect(lowerRefs({ all: { $ref: { step: "@trigger", path: [] } } })).toEqual({
				all: "js/ctx.request",
			});
		});

		it("dash/dot/leading-digit path keys still bracket-quote under the trigger root", () => {
			expect(lowerRefs({ x: { $ref: { step: "@trigger", path: ["body", "user-id", 0] } } })).toEqual({
				x: 'js/ctx.request.body["user-id"][0]',
			});
		});

		it("an ordinary step ref is UNAFFECTED — still js/ctx.state.<id>", () => {
			expect(lowerRefs({ a: { $ref: { step: "validate", path: ["productId"] } } })).toEqual({
				a: "js/ctx.state.validate.productId",
			});
		});

		it("end-to-end: a trigger-input ref resolves through the REAL Mapper against ctx.request", () => {
			// ctx exactly as TriggerBase.createContext builds it: payload at
			// ctx.request, state STARTS EMPTY. If lowering rooted at
			// ctx.state["@trigger"] (the blocker), this would resolve to
			// undefined. It must resolve to the request body value.
			const ctx = createCtx({}); // state = {}
			(ctx as unknown as { request: Record<string, unknown> }).request = {
				body: { name: "ada", count: 0 },
				headers: {},
				query: {},
				params: {},
			};
			const lowered = lowerRefs({
				name: { $ref: { step: "@trigger", path: ["body", "name"] } },
				zero: { $ref: { step: "@trigger", path: ["body", "count"] } },
			}) as unknown as ParamsDictionary;

			mapper.replaceObjectStrings(lowered, ctx, ctx.request as unknown as ParamsDictionary);

			const out = lowered as Record<string, unknown>;
			expect(out.name).toBe("ada");
			expect(out.zero).toBe(0); // falsy preserved
		});
	});

	// 2d. ERROR-ROOT branch (#317) — a ref rooted at the `@error` pseudo-step
	//     lowers to `js/ctx.error` (the tryCatch error envelope TryCatchNode
	//     writes on catch entry), NOT `js/ctx.state["@error"]`.
	describe("error-root — {$ref step:'@error'} → js/ctx.error + path", () => {
		it("field ref: error.message → js/ctx.error.message", () => {
			expect(lowerRefs({ m: { $ref: { step: "@error", path: ["message"] } } })).toEqual({
				m: "js/ctx.error.message",
			});
		});

		it("optional field ref: error.code → js/ctx.error.code", () => {
			expect(lowerRefs({ c: { $ref: { step: "@error", path: ["code"] } } })).toEqual({
				c: "js/ctx.error.code",
			});
		});

		it("whole-envelope ref: empty path → js/ctx.error", () => {
			expect(lowerRefs({ all: { $ref: { step: "@error", path: [] } } })).toEqual({
				all: "js/ctx.error",
			});
		});

		it("end-to-end: error refs resolve through the REAL Mapper against ctx.error", () => {
			const ctx = createCtx({});
			(ctx as unknown as { error: Record<string, unknown> }).error = {
				message: "kaboom",
				name: "Error",
				code: 402,
			};
			const lowered = lowerRefs({
				m: { $ref: { step: "@error", path: ["message"] } },
				c: { $ref: { step: "@error", path: ["code"] } },
			}) as unknown as ParamsDictionary;

			mapper.replaceObjectStrings(lowered, ctx, ctx.request as unknown as ParamsDictionary);

			const out = lowered as Record<string, unknown>;
			expect(out.m).toBe("kaboom");
			expect(out.c).toBe(402);
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

	// =========================================================================
	// 5. {$tpl} — a ref embedded in a string (#425) lowers to a js/`…` template
	//    literal, then resolves type-faithfully through the REAL Mapper.
	// =========================================================================

	describe("tpl — {$tpl} → js/`…${ctx.state…}…` template literal", () => {
		it("single interpolation between two string segments", () => {
			expect(
				lowerRefs({
					url: { $tpl: ["https://inv/stock/", { $ref: { step: "validate", path: ["productId"] } }, ""] },
				}),
			).toEqual({ url: "js/`https://inv/stock/${ctx.state.validate.productId}`" });
		});

		it("zero interpolations — plain string segment only", () => {
			expect(lowerRefs({ url: { $tpl: ["https://inv/health"] } })).toEqual({ url: "js/`https://inv/health`" });
		});

		it("adjacent interpolations ${a}${b} (empty middle segment)", () => {
			expect(
				lowerRefs({
					k: { $tpl: ["", { $ref: { step: "a", path: ["x"] } }, "", { $ref: { step: "b", path: ["y"] } }, ""] },
				}),
			).toEqual({ k: "js/`${ctx.state.a.x}${ctx.state.b.y}`" });
		});

		it("trigger-root ref inside a tpl → ${ctx.request…}", () => {
			expect(
				lowerRefs({ greeting: { $tpl: ["Hello, ", { $ref: { step: "@trigger", path: ["body", "name"] } }, "!"] } }),
			).toEqual({ greeting: "js/`Hello, ${ctx.request.body.name}!`" });
		});

		it("dash-named root inside a tpl bracket-quotes", () => {
			expect(lowerRefs({ k: { $tpl: ["/", { $ref: { step: "fan-out", path: ["id"] } }] } })).toEqual({
				k: 'js/`/${ctx.state["fan-out"].id}`',
			});
		});

		it("escapes backtick / backslash / literal $ in string segments", () => {
			expect(lowerRefs({ k: { $tpl: ["a`b\\c$d", { $ref: { step: "s", path: [] } }] } })).toEqual({
				k: "js/`a\\`b\\\\c\\$d${ctx.state.s}`",
			});
		});

		it("non-string literal segment (number) is stringified into the literal", () => {
			expect(lowerRefs({ k: { $tpl: ["v", 42, { $ref: { step: "s", path: ["x"] } }] } })).toEqual({
				k: "js/`v42${ctx.state.s.x}`",
			});
		});

		it("end-to-end: tpl resolves to the interpolated URL through the REAL Mapper", () => {
			const ctx = createCtx(POPULATED_STATE);
			const lowered = lowerRefs({
				url: { $tpl: ["https://inv/stock/", { $ref: { step: "validate", path: ["productId"] } }, "?qty="] },
				qtyUrl: { $tpl: ["q=", { $ref: { step: "validate", path: ["qty"] } }] },
			}) as unknown as ParamsDictionary;

			mapper.replaceObjectStrings(lowered, ctx, ctx as unknown as ParamsDictionary);

			const out = lowered as Record<string, unknown>;
			expect(out.url).toBe("https://inv/stock/P-123?qty=");
			expect(out.qtyUrl).toBe("q=4"); // number coerced by JS template, not dropped
		});

		it("end-to-end: falsy interpolation (0) preserved, not blanked", () => {
			const ctx = createCtx(POPULATED_STATE);
			const lowered = lowerRefs({
				k: {
					$tpl: [
						"free=",
						{ $ref: { step: "validate", path: ["free"] } },
						";ok=",
						{ $ref: { step: "validate", path: ["ok"] } },
					],
				},
			}) as unknown as ParamsDictionary;

			mapper.replaceObjectStrings(lowered, ctx, ctx as unknown as ParamsDictionary);

			expect((lowered as Record<string, unknown>).k).toBe("free=0;ok=false");
		});

		it("a $tpl alongside another key is NOT the sentinel (multi-key, untouched)", () => {
			const input = { weird: { $tpl: ["x"], other: 1 } };
			expect(lowerRefs(input)).toEqual(input);
		});
	});
});
