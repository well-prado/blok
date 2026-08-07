import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetLegacyExprWarningCache, normalizeWorkflow } from "../workflow/WorkflowNormalizer";

/**
 * #690 — the loader still ACCEPTS hand-written `js/` step inputs (migration
 * reality), but says so once per workflow at load time. These tests pin the
 * four properties the issue asks for: fires once, names workflow + step +
 * count, silenceable, and absent for structural IR.
 */

const wf = (steps: unknown[], name = "legacy-expr-test") => ({
	name,
	version: "1.0.0",
	trigger: { http: { method: "GET", path: "/legacy-expr-test" } },
	steps,
});

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	_resetLegacyExprWarningCache();
	Reflect.deleteProperty(process.env, "BLOK_SUPPRESS_LEGACY_EXPR_WARNING");
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
	Reflect.deleteProperty(process.env, "BLOK_SUPPRESS_LEGACY_EXPR_WARNING");
});

const messages = () => warn.mock.calls.map((c) => String(c[0]));

describe("WorkflowNormalizer legacy `js/` input deprecation warning", () => {
	it("warns once per workflow, naming the workflow, each step, and the count", () => {
		normalizeWorkflow(
			wf([
				{ id: "fetch", use: "api-call", inputs: { url: "js/ctx.request.body.url" } },
				{ id: "render", use: "pdf", inputs: { html: "js/ctx.state.fetch", meta: "js/ctx.state.fetch.meta" } },
			]),
			"workflows/json/legacy.json",
		);

		const [msg, ...rest] = messages().filter((m) => m.includes("[blok][deprecated]"));
		expect(rest).toEqual([]);
		expect(msg).toContain('workflow "legacy-expr-test"');
		expect(msg).toContain("workflows/json/legacy.json");
		expect(msg).toContain("3 step input(s)");
		expect(msg).toContain("2 step(s)");
		expect(msg).toContain("fetch (1)");
		expect(msg).toContain("render (2)");
		expect(msg).toContain("blokctl migrate refs");
		expect(msg).toContain("BLOK_SUPPRESS_LEGACY_EXPR_WARNING");
	});

	it("fires only once for a workflow loaded twice", () => {
		const raw = wf([{ id: "fetch", use: "api-call", inputs: { url: "js/ctx.request.body.url" } }]);
		normalizeWorkflow(raw, "workflows/json/legacy.json");
		normalizeWorkflow(raw, "workflows/json/legacy.json");
		expect(messages().filter((m) => m.includes("[blok][deprecated]"))).toHaveLength(1);
	});

	it("is silent for a structural `{$ref}` / `{$tpl}` workflow", () => {
		normalizeWorkflow(
			wf([
				{ id: "fetch", use: "api-call", inputs: { url: { $ref: { step: "@trigger", path: ["body", "url"] } } } },
				{
					id: "render",
					use: "pdf",
					inputs: {
						html: { $ref: { step: "fetch", path: [] } },
						title: { $tpl: ["#", { $ref: { step: "fetch", path: ["id"] } }] },
					},
				},
			]),
			"workflows/json/structural.json",
		);
		expect(messages().filter((m) => m.includes("[blok][deprecated]"))).toEqual([]);
	});

	it("is silent when BLOK_SUPPRESS_LEGACY_EXPR_WARNING is set", () => {
		process.env.BLOK_SUPPRESS_LEGACY_EXPR_WARNING = "1";
		normalizeWorkflow(wf([{ id: "fetch", use: "api-call", inputs: { url: "js/ctx.request.body.url" } }]));
		expect(messages().filter((m) => m.includes("[blok][deprecated]"))).toEqual([]);
	});

	it("does not nag about non-structural `js` escape hatches", () => {
		// Operators, calls and template literals have NO `{$ref}` equivalent —
		// they are ADR 0008's sanctioned escape hatch, so warning would be noise.
		normalizeWorkflow(
			wf([
				{
					id: "compute",
					use: "noop",
					inputs: {
						tenant: "js/ctx.request.headers['x-tenant'] || 'default'",
						label: "js/`order ${ctx.state.validate.id}`",
						size: "js/ctx.state.rows.filter((r) => r.active).length",
					},
				},
			]),
			"workflows/json/escape-hatch.json",
		);
		expect(messages().filter((m) => m.includes("[blok][deprecated]"))).toEqual([]);
	});

	it("finds legacy inputs nested inside branch / forEach / tryCatch / switch arms", () => {
		normalizeWorkflow(
			wf([
				{
					id: "route",
					branch: {
						when: "ctx.request.body.big",
						then: [{ id: "big", use: "noop", inputs: { v: "js/ctx.request.body.v" } }],
						else: [
							{
								id: "each",
								forEach: {
									in: "js/ctx.request.body.items",
									as: "item",
									do: [
										{
											id: "guard",
											tryCatch: {
												try: [{ id: "inner", use: "noop", inputs: { sku: "js/ctx.state.item.sku" } }],
												catch: [{ id: "oops", use: "noop", inputs: { why: "js/ctx.error.message" } }],
											},
										},
									],
								},
							},
						],
					},
				},
			]),
			"workflows/json/nested.json",
		);

		const msg = messages().find((m) => m.includes("[blok][deprecated]")) ?? "";
		expect(msg).toContain("3 step input(s)");
		expect(msg).toContain("big (1)");
		expect(msg).toContain("inner (1)");
		expect(msg).toContain("oops (1)");
		// `forEach.in` is a control field, not a step input — the structural form
		// does not reach it, so it must not be counted.
		expect(msg).toContain("3 step(s)");
	});
});
