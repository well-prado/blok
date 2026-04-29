import { afterEach, describe, expect, it } from "vitest";
import { _resetWildcardWarningCache, normalizeWorkflow } from "../../../src/workflow/WorkflowNormalizer";

afterEach(() => {
	_resetWildcardWarningCache();
});

describe("WorkflowNormalizer — v1 input", () => {
	it("normalizes legacy steps[]+nodes{} into internal shape", () => {
		const v1 = {
			name: "Legacy",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [
				{ name: "fetch", node: "@blokjs/api-call", type: "module" },
				{ name: "respond", node: "@blokjs/respond", type: "module" },
			],
			nodes: {
				fetch: { inputs: { url: "https://example.com" } },
				respond: { inputs: { body: "js/ctx.vars['fetch']" } },
			},
		};
		const out = normalizeWorkflow(v1, "test.json");
		expect(out.steps).toHaveLength(2);
		expect(out.steps[0].name).toBe("fetch");
		expect(out.steps[0].node).toBe("@blokjs/api-call");
		expect(out.steps[0].type).toBe("module");
		expect(out.nodes.fetch.inputs).toEqual({ url: "https://example.com" });
		expect(out.nodes.respond.inputs).toEqual({ body: "js/ctx.vars['fetch']" });
	});

	it("converts method '*' to 'ANY' on http trigger", () => {
		const v1 = {
			name: "Wildcard",
			version: "1.0.0",
			trigger: { http: { method: "*", path: "/" } },
			steps: [{ name: "step", node: "@blokjs/api-call", type: "module" }],
			nodes: { step: { inputs: {} } },
		};
		const out = normalizeWorkflow(v1, "wildcard.json");
		const httpTrigger = out.trigger.http as { method: string };
		expect(httpTrigger.method).toBe("ANY");
	});

	it("preserves set_var: false from v1 (PersistenceHelper handles it)", () => {
		const v1 = {
			name: "SetVar",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ name: "step", node: "@blokjs/api-call", type: "module", set_var: false }],
			nodes: { step: { inputs: {} } },
		};
		const out = normalizeWorkflow(v1, "test.json");
		expect(out.steps[0].set_var).toBe(false);
		// also surfaces as ephemeral so PersistenceHelper handles either path
		expect(out.steps[0].ephemeral).toBe(true);
	});

	it("preserves trigger kinds other than http unchanged", () => {
		const v1 = {
			name: "Cron",
			version: "1.0.0",
			trigger: { cron: { schedule: "0 * * * *" } },
			steps: [{ name: "step", node: "@blokjs/api-call", type: "module" }],
		};
		const out = normalizeWorkflow(v1, "cron.json");
		expect(out.trigger.cron).toEqual({ schedule: "0 * * * *" });
	});
});

describe("WorkflowNormalizer — v2 input", () => {
	it("inlines inputs from v2 step shape onto nodes map", () => {
		const v2 = {
			name: "V2",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "fetch", use: "@blokjs/api-call", inputs: { url: "https://example.com" } }],
		};
		const out = normalizeWorkflow(v2, "v2.json");
		expect(out.steps[0].name).toBe("fetch");
		expect(out.steps[0].node).toBe("@blokjs/api-call");
		expect(out.nodes.fetch.inputs).toEqual({ url: "https://example.com" });
	});

	it("infers type when not set explicitly", () => {
		const v2 = {
			name: "Infer",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "x", use: "@blokjs/api-call", inputs: {} }],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].type).toBe("module");
	});

	it("carries v2 persistence knobs onto the internal step", () => {
		const v2 = {
			name: "Persist",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [
				{ id: "a", use: "@blokjs/api-call", as: "users" },
				{ id: "b", use: "@blokjs/api-call", spread: true },
				{ id: "c", use: "@blokjs/api-call", ephemeral: true },
			],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].as).toBe("users");
		expect(out.steps[1].spread).toBe(true);
		expect(out.steps[2].ephemeral).toBe(true);
	});

	it("rejects steps with both `as` and `spread`", () => {
		const v2 = {
			name: "Bad",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "x", use: "@blokjs/api-call", as: "y", spread: true }],
		};
		expect(() => normalizeWorkflow(v2)).toThrow(/mutually exclusive/);
	});

	it("compiles a branch step into the legacy if-else node shape", () => {
		const v2 = {
			name: "Branch",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [
				{
					id: "route",
					branch: {
						when: '$.req.method === "POST"',
						then: [{ id: "create", use: "@blokjs/respond", inputs: { body: "ok" } }],
						else: [{ id: "read", use: "@blokjs/respond", inputs: { body: "no" } }],
					},
				},
			],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].name).toBe("route");
		expect(out.steps[0].node).toBe("@blokjs/if-else");
		expect(out.steps[0].flow).toBe(true);
		expect(out.nodes.route.conditions).toHaveLength(2);
		expect(out.nodes.route.conditions?.[0].type).toBe("if");
		expect(out.nodes.route.conditions?.[0].condition).toBe('$.req.method === "POST"');
		expect(out.nodes.route.conditions?.[1].type).toBe("else");
	});

	it("omits else branch when not provided", () => {
		const v2 = {
			name: "ElseLess",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [
				{
					id: "route",
					branch: {
						when: "true",
						then: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
					},
				},
			],
		};
		const out = normalizeWorkflow(v2);
		expect(out.nodes.route.conditions).toHaveLength(1);
		expect(out.nodes.route.conditions?.[0].type).toBe("if");
	});

	it("rejects branch missing id", () => {
		const v2 = {
			name: "Bad",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ branch: { when: "true", then: [] } }],
		};
		expect(() => normalizeWorkflow(v2)).toThrow(/id/);
	});

	it("rejects branch missing when", () => {
		const v2 = {
			name: "Bad",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "x", branch: { when: "", then: [] } }],
		};
		expect(() => normalizeWorkflow(v2)).toThrow(/when/);
	});
});

describe("WorkflowNormalizer — v2 builder envelope", () => {
	it("unwraps {_blokV2: true, _config: {...}}", () => {
		const builder = {
			_blokV2: true,
			_config: {
				name: "FromBuilder",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ id: "x", use: "@blokjs/api-call", inputs: { url: "..." } }],
			},
		};
		const out = normalizeWorkflow(builder);
		expect(out.name).toBe("FromBuilder");
		expect(out.steps[0].name).toBe("x");
	});

	it("unwraps legacy {_config: {...}} shape (no _blokV2 tag)", () => {
		const legacy = {
			_config: {
				name: "Legacy",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ name: "x", node: "@blokjs/api-call", type: "module" }],
				nodes: { x: { inputs: { url: "..." } } },
			},
		};
		const out = normalizeWorkflow(legacy);
		expect(out.name).toBe("Legacy");
		expect(out.nodes.x.inputs).toEqual({ url: "..." });
	});
});

describe("WorkflowNormalizer — error paths", () => {
	it("throws when input is not an object", () => {
		expect(() => normalizeWorkflow(null)).toThrow();
		expect(() => normalizeWorkflow("string")).toThrow();
		expect(() => normalizeWorkflow(42)).toThrow();
	});

	it("throws when a step lacks both id and name", () => {
		const wf = {
			name: "Bad",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ use: "@blokjs/api-call" }],
		};
		expect(() => normalizeWorkflow(wf)).toThrow(/id|name/);
	});
});
