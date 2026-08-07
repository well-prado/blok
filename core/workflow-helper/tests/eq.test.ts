import { describe, expect, it } from "vitest";
import { branch } from "../src/components/branch";
import { eq, gt, gte, lt, lte, ne, not } from "../src/components/eq";

// Exact replica of the if-else node's condition evaluator
// (nodes/control-flow/if-else@1.0.0/index.ts runJs) — a raw Function over the
// live ctx, NOT the Mapper. This is the path that makes `js/`-prefixed
// conditions fail, and that eq() must produce a valid string for.
function runJs(str: string, ctx: unknown): unknown {
	return Function("ctx", "data", "func", "vars", `"use strict";return (${str});`)(ctx, {}, {}, {});
}

describe("eq()", () => {
	it("emits a raw ctx === literal string (no js/ prefix)", () => {
		expect(eq("ctx.req.method", "POST")).toBe('ctx.request.method === "POST"');
		expect(eq("ctx.state.count", 3)).toBe("ctx.state.count === 3");
		expect(eq("ctx.state.active", true)).toBe("ctx.state.active === true");
	});

	it("canonicalizes alias path segments to real ctx fields", () => {
		expect(eq("ctx.req.headers.host", "x")).toBe('ctx.request.headers.host === "x"');
		expect(eq("ctx.prev.data.ok", true)).toBe("ctx.response.data.ok === true");
		expect(eq("ctx.vars.userId", "u1")).toBe('ctx.state.userId === "u1"');
		// already-canonical paths are left alone
		expect(eq("ctx.request.method", "GET")).toBe('ctx.request.method === "GET"');
		expect(eq("ctx.state.req", 1)).toBe("ctx.state.req === 1"); // only the leading segment
	});

	it("treats a non-ctx-path string operand as a JSON literal, not a path", () => {
		expect(eq("state.count", 3)).toBe('"state.count" === 3');
		expect(eq("POST", "POST")).toBe('"POST" === "POST"');
	});

	it("evaluates correctly via the if-else runJs path", () => {
		const when = eq("ctx.req.method", "POST");
		expect(runJs(when, { request: { method: "POST" } })).toBe(true);
		expect(runJs(when, { request: { method: "GET" } })).toBe(false);

		expect(runJs(eq("ctx.state.count", 3), { state: { count: 3 } })).toBe(true);
		expect(runJs(eq("ctx.state.count", 3), { state: { count: 4 } })).toBe(false);
		expect(runJs(eq("ctx.prev.data.ok", true), { response: { data: { ok: true } } })).toBe(true);
	});

	it("survives branch() untouched as a raw when string", () => {
		const step = branch({ id: "route", when: eq("ctx.req.method", "POST"), then: [{ id: "a", use: "x" }] });
		expect(step.branch.when).toBe('ctx.request.method === "POST"');
		// and that string still evaluates correctly through the runJs path
		expect(runJs(step.branch.when, { request: { method: "POST" } })).toBe(true);
	});

	it("passes a bare ctx path `when` through verbatim as a raw ctx truthiness check", () => {
		// Unlike eq()'s operands, a bare `when` string is NOT alias-canonicalized —
		// it's handed straight to the if-else node. `ctx.req` is a real runtime
		// alias of `ctx.request` (core/shared/src/types/Context.ts), so both spellings work.
		const step = branch({ id: "ok", when: "ctx.req.body.active", then: [{ id: "a", use: "x" }] });
		expect(step.branch.when).toBe("ctx.req.body.active");
		expect(runJs(step.branch.when, { req: { body: { active: true } } })).toBe(true);
		expect(runJs(step.branch.when, { req: { body: { active: false } } })).toBe(false);
	});
});

describe("comparators (ne/gt/gte/lt/lte)", () => {
	it("emit the right operator with canonicalized ctx paths", () => {
		expect(ne("ctx.state.fetch.error", null)).toBe("ctx.state.fetch.error !== null");
		expect(gt("ctx.state.count", 10)).toBe("ctx.state.count > 10");
		expect(gte("ctx.state.count", 10)).toBe("ctx.state.count >= 10");
		expect(lt("ctx.state.count", 10)).toBe("ctx.state.count < 10");
		expect(lte("ctx.state.count", 10)).toBe("ctx.state.count <= 10");
		expect(ne("ctx.req.method", "GET")).toBe('ctx.request.method !== "GET"');
		// Both operands can be ctx paths — each is detected independently.
		expect(gt('ctx.state.order.items[0]["unit-price"]', "ctx.prev.data.limit")).toBe(
			'ctx.state.order.items[0]["unit-price"] > ctx.response.data.limit',
		);
		expect(not("ctx.state.ready")).toBe("!(ctx.state.ready)");
	});

	it("evaluate correctly via the if-else runJs path", () => {
		expect(runJs(ne("ctx.state.error", null), { state: { error: "boom" } })).toBe(true);
		expect(runJs(ne("ctx.state.error", null), { state: { error: null } })).toBe(false);
		expect(runJs(gt("ctx.state.count", 10), { state: { count: 11 } })).toBe(true);
		expect(runJs(gt("ctx.state.count", 10), { state: { count: 10 } })).toBe(false);
		expect(runJs(gte("ctx.state.count", 10), { state: { count: 10 } })).toBe(true);
		expect(runJs(lte("ctx.state.count", 10), { state: { count: 10 } })).toBe(true);
		expect(runJs(not("ctx.state.ready"), { state: { ready: false } })).toBe(true);
	});
});
