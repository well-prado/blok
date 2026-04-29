import { describe, expect, it } from "vitest";
import { $, JS_EXPR_TAG, type V2Step, branch, unwrapProxies, workflow } from "../src/index";

describe("v2 DSL — $ proxy", () => {
	it("compiles property access to js/ctx.<path> via toString()", () => {
		expect(String($.req.body.id)).toBe("js/ctx.req.body.id");
		expect(String($.state.users)).toBe("js/ctx.state.users");
		expect(String($.prev.data)).toBe("js/ctx.prev.data");
	});

	it("compiles bracket access for hyphenated keys", () => {
		const expr = $.state["my-step"];
		expect(String(expr)).toBe('js/ctx.state["my-step"]');
	});

	it("compiles numeric index access with bracket notation", () => {
		expect(String($.state.users[0])).toBe("js/ctx.state.users[0]");
		expect(String($.state.items[42].name)).toBe("js/ctx.state.items[42].name");
	});

	it("toJSON returns the compiled string for JSON.stringify", () => {
		const wrapped = { url: $.req.body.url };
		const json = JSON.parse(JSON.stringify(wrapped));
		expect(json.url).toBe("js/ctx.req.body.url");
	});

	it("Symbol.toPrimitive returns the compiled string", () => {
		expect(`${$.state.foo}`).toBe("js/ctx.state.foo");
	});

	it("does not pretend to be a thenable (no .then)", () => {
		expect(($.state as unknown as { then?: unknown }).then).toBeUndefined();
	});

	it("carries the JS_EXPR_TAG symbol for unwrap detection", () => {
		const tagged = $.state.x as unknown as { [JS_EXPR_TAG]: string };
		expect(tagged[JS_EXPR_TAG]).toBe("ctx.state.x");
	});
});

describe("v2 DSL — unwrapProxies", () => {
	it("converts proxy values to js/ strings inside objects", () => {
		const input = { url: $.req.body.url, id: $.req.params.id };
		const out = unwrapProxies(input) as Record<string, unknown>;
		expect(out.url).toBe("js/ctx.req.body.url");
		expect(out.id).toBe("js/ctx.req.params.id");
	});

	it("recurses into nested objects and arrays", () => {
		const input = {
			a: { b: $.state.x, c: [$.state.y, "literal", { d: $.req.body.z }] },
		};
		const out = unwrapProxies(input) as Record<string, unknown>;
		const a = out.a as { b: unknown; c: unknown[] };
		expect(a.b).toBe("js/ctx.state.x");
		expect(a.c[0]).toBe("js/ctx.state.y");
		expect(a.c[1]).toBe("literal");
		expect((a.c[2] as { d: unknown }).d).toBe("js/ctx.req.body.z");
	});

	it("leaves primitives untouched", () => {
		expect(unwrapProxies("hello")).toBe("hello");
		expect(unwrapProxies(42)).toBe(42);
		expect(unwrapProxies(null)).toBe(null);
		expect(unwrapProxies(undefined)).toBe(undefined);
		expect(unwrapProxies(true)).toBe(true);
	});
});

describe("v2 DSL — workflow() factory", () => {
	it("validates and returns a v2 builder envelope", () => {
		const wf = workflow({
			name: "Test",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "step-a", use: "@blokjs/api-call", inputs: { url: "https://example.com" } }],
		});
		expect(wf._blokV2).toBe(true);
		expect(wf._config.name).toBe("Test");
		expect(wf._config.steps).toHaveLength(1);
	});

	it("compiles $ proxy expressions in inputs at definition time", () => {
		const wf = workflow({
			name: "Test",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [
				{
					id: "echo",
					use: "@blokjs/respond",
					inputs: { body: $.req.body, who: $.req.params.id },
				},
			],
		});
		const step = wf._config.steps[0] as { inputs: Record<string, unknown> };
		expect(step.inputs.body).toBe("js/ctx.req.body");
		expect(step.inputs.who).toBe("js/ctx.req.params.id");
	});

	it("rejects steps missing id or use", () => {
		expect(() =>
			workflow({
				name: "Bad",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ use: "@blokjs/foo" } as unknown as V2Step],
			}),
		).toThrow(/id/i);
	});

	it("rejects steps with both `as` and `spread`", () => {
		expect(() =>
			workflow({
				name: "Bad",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ id: "x", use: "@blokjs/foo", as: "y", spread: true }],
			}),
		).toThrow(/mutually exclusive/i);
	});

	it("rejects unknown trigger kinds", () => {
		expect(() =>
			workflow({
				name: "Bad",
				version: "1.0.0",
				trigger: { telepathy: {} },
				steps: [{ id: "x", use: "@blokjs/foo", inputs: {} }],
			}),
		).toThrow(/not recognized/);
	});

	it("validates per-kind trigger config (cron requires schedule)", () => {
		expect(() =>
			workflow({
				name: "Bad",
				version: "1.0.0",
				trigger: { cron: {} },
				steps: [{ id: "x", use: "@blokjs/foo", inputs: {} }],
			}),
		).toThrow();
	});
});

describe("v2 DSL — branch() primitive", () => {
	it("creates a branch step with when/then/else", () => {
		const b = branch({
			id: "route",
			when: '$.req.method === "POST"',
			then: [{ id: "create", use: "@blokjs/respond", inputs: {} }],
			else: [{ id: "read", use: "@blokjs/respond", inputs: {} }],
		});
		expect(b.id).toBe("route");
		expect(b.branch.when).toBe('$.req.method === "POST"');
		expect(b.branch.then).toHaveLength(1);
		expect(b.branch.else).toHaveLength(1);
	});

	it("compiles a $ proxy `when` expression to a string", () => {
		const b = branch({
			id: "x",
			when: $.req.query.kind,
			then: [{ id: "a", use: "@blokjs/respond", inputs: {} }],
		});
		expect(b.branch.when).toBe("js/ctx.req.query.kind");
	});

	it("compiles $ proxy expressions inside nested step inputs", () => {
		const b = branch({
			id: "x",
			when: '$.req.method === "GET"',
			then: [{ id: "respond", use: "@blokjs/respond", inputs: { body: $.state.fetch } }],
		});
		const step = b.branch.then[0] as { inputs: Record<string, unknown> };
		expect(step.inputs.body).toBe("js/ctx.state.fetch");
	});

	it("rejects branches without an id", () => {
		expect(() => branch({ when: "true", then: [] } as unknown as Parameters<typeof branch>[0])).toThrow(/id/);
	});

	it("rejects empty when expressions", () => {
		expect(() => branch({ id: "x", when: "", then: [] })).toThrow(/when/);
	});

	it("omits else when not provided", () => {
		const b = branch({
			id: "x",
			when: "true",
			then: [{ id: "a", use: "@blokjs/respond", inputs: {} }],
		});
		expect(b.branch.else).toBeUndefined();
	});
});
