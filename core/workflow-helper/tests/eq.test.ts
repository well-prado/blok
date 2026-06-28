import { describe, expect, it } from "vitest";
import { branch } from "../src/components/branch";
import { eq, gt, gte, lt, lte, ne, not } from "../src/components/eq";
import { $ } from "../src/proxy/$";

// Exact replica of the if-else node's condition evaluator
// (nodes/control-flow/if-else@1.0.0/index.ts runJs) — a raw Function over the
// live ctx, NOT the Mapper. This is the path that makes `js/`-prefixed and
// `$.`-prefixed conditions fail, and that eq() must produce a valid string for.
function runJs(str: string, ctx: unknown): unknown {
	return Function("ctx", "data", "func", "vars", `"use strict";return (${str});`)(ctx, {}, {}, {});
}

describe("eq()", () => {
	it("emits a raw ctx === literal string (no js/ prefix)", () => {
		expect(eq($.req.method, "POST")).toBe('ctx.request.method === "POST"');
		expect(eq($.state.count, 3)).toBe("ctx.state.count === 3");
		expect(eq($.state.active, true)).toBe("ctx.state.active === true");
	});

	it("canonicalizes proxy alias segments to real ctx fields", () => {
		expect(eq($.req.headers.host, "x")).toBe('ctx.request.headers.host === "x"');
		expect(eq($.prev.data.ok, true)).toBe("ctx.response.data.ok === true");
		expect(eq($.vars.userId, "u1")).toBe('ctx.state.userId === "u1"');
		// already-canonical paths are left alone
		expect(eq($.request.method, "GET")).toBe('ctx.request.method === "GET"');
		expect(eq($.state.req, 1)).toBe("ctx.state.req === 1"); // only the leading segment
	});

	it("evaluates correctly via the if-else runJs path", () => {
		const when = eq($.req.method, "POST");
		expect(runJs(when, { request: { method: "POST" } })).toBe(true);
		expect(runJs(when, { request: { method: "GET" } })).toBe(false);

		expect(runJs(eq($.state.count, 3), { state: { count: 3 } })).toBe(true);
		expect(runJs(eq($.state.count, 3), { state: { count: 4 } })).toBe(false);
		expect(runJs(eq($.prev.data.ok, true), { response: { data: { ok: true } } })).toBe(true);
	});

	it("survives branch() untouched as a raw when string", () => {
		const step = branch({ id: "route", when: eq($.req.method, "POST"), then: [{ id: "a", use: "x" }] });
		expect(step.branch.when).toBe('ctx.request.method === "POST"');
		// and that string still evaluates correctly through the runJs path
		expect(runJs(step.branch.when, { request: { method: "POST" } })).toBe(true);
	});

	it("turns a bare $ proxy `when` into a raw ctx truthiness check", () => {
		const step = branch({ id: "ok", when: $.req.body.active, then: [{ id: "a", use: "x" }] });
		expect(step.branch.when).toBe("ctx.request.body.active");
		expect(runJs(step.branch.when, { request: { body: { active: true } } })).toBe(true);
		expect(runJs(step.branch.when, { request: { body: { active: false } } })).toBe(false);
	});
});

describe("comparators (ne/gt/gte/lt/lte)", () => {
	it("emit the right operator with canonicalized ctx paths", () => {
		expect(ne($.state.fetch.error, null)).toBe("ctx.state.fetch.error !== null");
		expect(gt($.state.count, 10)).toBe("ctx.state.count > 10");
		expect(gte($.state.count, 10)).toBe("ctx.state.count >= 10");
		expect(lt($.state.count, 10)).toBe("ctx.state.count < 10");
		expect(lte($.state.count, 10)).toBe("ctx.state.count <= 10");
		expect(ne($.req.method, "GET")).toBe('ctx.request.method !== "GET"');
		expect(gt($.state.order.items[0]["unit-price"], $.prev.data.limit)).toBe(
			'ctx.state.order.items[0]["unit-price"] > ctx.response.data.limit',
		);
		expect(not($.state.ready)).toBe("!(ctx.state.ready)");
	});

	it("evaluate correctly via the if-else runJs path", () => {
		expect(runJs(ne($.state.error, null), { state: { error: "boom" } })).toBe(true);
		expect(runJs(ne($.state.error, null), { state: { error: null } })).toBe(false);
		expect(runJs(gt($.state.count, 10), { state: { count: 11 } })).toBe(true);
		expect(runJs(gt($.state.count, 10), { state: { count: 10 } })).toBe(false);
		expect(runJs(gte($.state.count, 10), { state: { count: 10 } })).toBe(true);
		expect(runJs(lte($.state.count, 10), { state: { count: 10 } })).toBe(true);
		expect(runJs(not($.state.ready), { state: { ready: false } })).toBe(true);
	});
});
