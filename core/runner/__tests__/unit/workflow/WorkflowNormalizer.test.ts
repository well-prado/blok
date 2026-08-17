import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

	it("rejects set_var with a migration hint (removed in v0.5)", () => {
		const v1 = {
			name: "SetVar",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ name: "step", node: "@blokjs/api-call", type: "module", set_var: false }],
			nodes: { step: { inputs: {} } },
		};
		expect(() => normalizeWorkflow(v1, "test.json")).toThrow(/`set_var`, which was removed in v0.5/);
	});

	it("rejects set_var inside a branch sub-pipeline (recursive walk)", () => {
		const v2 = {
			name: "NestedSetVar",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [
				{
					id: "route",
					branch: {
						when: "true",
						then: [{ id: "inner", use: "@blokjs/respond", set_var: true }],
					},
				},
			],
		};
		expect(() => normalizeWorkflow(v2, "nested.json")).toThrow(/`set_var`, which was removed in v0.5/);
	});

	it("rejects a duplicate step id (flat config map → silent wrong-inputs)", () => {
		const wf = {
			name: "Dup",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [
				{ id: "a", use: "@blokjs/respond" },
				{ id: "a", use: "@blokjs/respond" },
			],
		};
		expect(() => normalizeWorkflow(wf, "dup.json")).toThrow(/duplicate step id "a"/);
	});

	it("rejects a duplicate step id across mutually-exclusive branch arms", () => {
		const wf = {
			name: "DupArms",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [
				{
					id: "route",
					branch: {
						when: "true",
						then: [{ id: "run", use: "@blokjs/respond" }],
						else: [{ id: "run", use: "@blokjs/respond" }],
					},
				},
			],
		};
		expect(() => normalizeWorkflow(wf, "duparms.json")).toThrow(/duplicate step id "run"/);
	});

	it("allows the same downstream key via unique ids + `as`", () => {
		const wf = {
			name: "AsOk",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [
				{
					id: "route",
					branch: {
						when: "true",
						then: [{ id: "runA", as: "run", use: "@blokjs/respond" }],
						else: [{ id: "runB", as: "run", use: "@blokjs/respond" }],
					},
				},
			],
		};
		expect(() => normalizeWorkflow(wf, "asok.json")).not.toThrow();
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

	it("carries idempotencyKey + idempotencyKeyTTL onto the internal step", () => {
		const v2 = {
			name: "Idem",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "fetch",
					use: "@blokjs/api-call",
					inputs: { url: "https://example.com" },
					idempotencyKey: "user-123",
					idempotencyKeyTTL: 60_000,
				},
			],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].idempotencyKey).toBe("user-123");
		expect(out.steps[0].idempotencyKeyTTL).toBe(60_000);
	});

	it("ignores empty-string idempotencyKey (treats as absent)", () => {
		const v2 = {
			name: "Idem",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "fetch", use: "@blokjs/api-call", idempotencyKey: "" }],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].idempotencyKey).toBeUndefined();
	});

	it("carries a retry config block onto the internal step", () => {
		const v2 = {
			name: "Retried",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "flaky",
					use: "@blokjs/api-call",
					retry: { maxAttempts: 4, minTimeoutInMs: 250, maxTimeoutInMs: 5000, factor: 3 },
				},
			],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].retry).toEqual({
			maxAttempts: 4,
			minTimeoutInMs: 250,
			maxTimeoutInMs: 5000,
			factor: 3,
		});
	});

	// #679 — this field was validated by the v2 schema and honoured by
	// RunnerSteps, but the normalizer copied only the four timing keys, so it
	// never reached the runner from ANY authored workflow. Both step-level and
	// job-level selective retry were dead until it was carried through.
	it("carries nonRetryableErrorNames through, dropping non-string entries", () => {
		const v2 = {
			name: "Selective",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "guard",
					use: "@blokjs/api-call",
					retry: {
						maxAttempts: 3,
						nonRetryableErrorNames: ["GRAPH_STILL_A_TREE", "", 42, "SNAPSHOT_CHANGED"],
					} as Record<string, unknown>,
				},
			],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].retry).toEqual({
			maxAttempts: 3,
			nonRetryableErrorNames: ["GRAPH_STILL_A_TREE", "SNAPSHOT_CHANGED"],
		});
	});

	it("ignores retry config without an integer maxAttempts (defensive)", () => {
		const v2 = {
			name: "Bad",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "x", use: "@blokjs/api-call", retry: { minTimeoutInMs: 100 } as Record<string, unknown> }],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].retry).toBeUndefined();
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

describe("WorkflowNormalizer — sub-workflow step", () => {
	it("normalizes a minimal sub-workflow step", () => {
		const v2 = {
			name: "Parent",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "call-child", subworkflow: "send-receipt" }],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].name).toBe("call-child");
		expect(out.steps[0].node).toBe("@blokjs/subworkflow");
		expect(out.steps[0].type).toBe("subworkflow");
		expect(out.steps[0].subworkflow).toBe("send-receipt");
		// Default wait when omitted = true (block on completion).
		expect(out.steps[0].wait).toBe(true);
	});

	it("places sub-workflow inputs on nodes[id].inputs (so blueprint mapper resolves $ refs)", () => {
		const v2 = {
			name: "Parent",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "notify",
					subworkflow: "send-email",
					inputs: { to: "js/ctx.req.body.email", subject: "Order #1" },
				},
			],
		};
		const out = normalizeWorkflow(v2);
		expect(out.nodes.notify.inputs).toEqual({
			to: "js/ctx.req.body.email",
			subject: "Order #1",
		});
	});

	it("threads idempotencyKey + retry through onto the InternalStep", () => {
		const v2 = {
			name: "Cached parent",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "expensive",
					subworkflow: "llm-pipeline",
					idempotencyKey: "req-abc",
					idempotencyKeyTTL: 60_000,
					retry: { maxAttempts: 3, minTimeoutInMs: 200, factor: 2 },
				},
			],
		};
		const out = normalizeWorkflow(v2);
		expect(out.steps[0].idempotencyKey).toBe("req-abc");
		expect(out.steps[0].idempotencyKeyTTL).toBe(60_000);
		expect(out.steps[0].retry).toEqual({ maxAttempts: 3, minTimeoutInMs: 200, factor: 2 });
	});

	it("rejects empty subworkflow name with a clear error", () => {
		const v2 = {
			name: "Bad",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "x", subworkflow: "" }],
		};
		// Empty subworkflow name fails the discriminator check at top of
		// the loop and falls through to the regular-step path, which then
		// throws because `use` is also missing.
		expect(() => normalizeWorkflow(v2)).toThrow();
	});

	it("accepts wait: false on a sub-workflow step (fire-and-forget)", () => {
		const v2 = {
			name: "WithFireAndForget",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "bg", subworkflow: "child", wait: false }],
		};
		const normalized = normalizeWorkflow(v2) as unknown as { steps: Array<{ wait: boolean }> };
		expect(normalized.steps[0].wait).toBe(false);
	});

	it("accepts wait: false combined with idempotencyKey (at-most-once dispatch)", () => {
		const v2 = {
			name: "WithCachedDispatch",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "bg", subworkflow: "child", wait: false, idempotencyKey: "req-123" }],
		};
		const normalized = normalizeWorkflow(v2) as unknown as {
			steps: Array<{ wait: boolean; idempotencyKey?: string }>;
		};
		expect(normalized.steps[0].wait).toBe(false);
		expect(normalized.steps[0].idempotencyKey).toBe("req-123");
	});

	it("rejects as + spread combo on a sub-workflow step", () => {
		const v2 = {
			name: "Bad",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "x", subworkflow: "child", as: "out", spread: true }],
		};
		expect(() => normalizeWorkflow(v2)).toThrow(/mutually exclusive/);
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

// v0.5.2 — workflow-level middleware. The `middleware` field at the
// workflow root is overloaded: `true` is the marker bit ("I am a
// middleware"), an array is the workflow-level chain ("apply these
// middleware to my runs"). The two semantics must remain mutually
// exclusive — author confusion here would lead to surprising behaviour.
describe("WorkflowNormalizer — workflow-level middleware (v0.5.2)", () => {
	it("treats `middleware: true` as the marker bit (existing v0.5 behaviour)", () => {
		const wf = {
			name: "auth-check",
			version: "1.0.0",
			middleware: true,
			steps: [{ id: "noop", use: "@blokjs/expr", inputs: { expression: "true" } }],
		};
		const out = normalizeWorkflow(wf);
		expect(out.middleware).toBe(true);
		expect(out.appliedMiddleware).toBeUndefined();
	});

	it("routes `middleware: string[]` into appliedMiddleware (workflow-level chain)", () => {
		const wf = {
			name: "Protected",
			version: "1.0.0",
			middleware: ["jwt-auth", "rate-limit"],
			trigger: { http: { method: "POST" } },
			steps: [{ id: "ok", use: "@blokjs/expr", inputs: { expression: "true" } }],
		};
		const out = normalizeWorkflow(wf);
		expect(out.middleware).toBeUndefined();
		expect(out.appliedMiddleware).toEqual(["jwt-auth", "rate-limit"]);
	});

	it("filters non-string entries from the middleware array", () => {
		const wf = {
			name: "Sloppy",
			version: "1.0.0",
			middleware: ["good", 42, null, "", "also-good"] as unknown as string[],
			trigger: { http: { method: "POST" } },
			steps: [{ id: "ok", use: "@blokjs/expr", inputs: { expression: "true" } }],
		};
		const out = normalizeWorkflow(wf);
		expect(out.appliedMiddleware).toEqual(["good", "also-good"]);
	});

	it("treats an empty middleware array as undefined (no workflow-level chain)", () => {
		const wf = {
			name: "Empty",
			version: "1.0.0",
			middleware: [] as string[],
			trigger: { http: { method: "POST" } },
			steps: [{ id: "ok", use: "@blokjs/expr", inputs: { expression: "true" } }],
		};
		const out = normalizeWorkflow(wf);
		expect(out.middleware).toBeUndefined();
		expect(out.appliedMiddleware).toBeUndefined();
	});

	it("preserves the marker for middleware-only workflows (no appliedMiddleware leaks in)", () => {
		// Regression — a middleware-only workflow shouldn't accidentally
		// route the marker through the array path.
		const wf = {
			name: "auth-check",
			version: "1.0.0",
			middleware: true,
			steps: [{ id: "noop", use: "@blokjs/expr", inputs: { expression: "true" } }],
		};
		const out = normalizeWorkflow(wf);
		expect(out.middleware).toBe(true);
		expect("appliedMiddleware" in out).toBe(false);
	});
});

describe("WorkflowNormalizer — typed-client metadata carry-through (P1.1)", () => {
	// A stand-in for a Zod schema reference — the normalizer carries it verbatim
	// without inspecting it, so any object identity proves the pass-through.
	const inputSchema = { __kind: "input-schema" };
	const outputSchema = { __kind: "output-schema" };
	const events = { progress: { __kind: "progress" }, done: { __kind: "done" } };

	it("carries input/output/events verbatim through normalization", () => {
		const wf = {
			name: "Typed",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/typed" } },
			input: inputSchema,
			output: outputSchema,
			events,
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		};
		const out = normalizeWorkflow(wf);
		expect(out.input).toBe(inputSchema);
		expect(out.output).toBe(outputSchema);
		expect(out.events).toBe(events);
	});

	it("carries metadata through the v2 builder envelope (_config) too", () => {
		const wf = {
			_blokV2: true,
			_config: {
				name: "TypedV2",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/typed2" } },
				output: outputSchema,
				steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
			},
		};
		const out = normalizeWorkflow(wf);
		expect(out.output).toBe(outputSchema);
	});

	it("omits the fields entirely when not declared (no undefined keys)", () => {
		const wf = {
			name: "Plain",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/plain" } },
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		};
		const out = normalizeWorkflow(wf);
		expect("input" in out).toBe(false);
		expect("output" in out).toBe(false);
		expect("events" in out).toBe(false);
	});

	it("ignores a non-object events value (defensive)", () => {
		const wf = {
			name: "BadEvents",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/bad" } },
			events: "not-an-object",
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		};
		const out = normalizeWorkflow(wf);
		expect("events" in out).toBe(false);
	});
});

// =============================================================================
// Issue #301 / #302 — `ui` survives IR → normalize → toJson round-trip for
// every step kind including steps nested inside branch / forEach / switch /
// tryCatch arms. The runner ignores `ui` at execution; this is purely so the
// canvas round-trip preserves authoring metadata that the schemas accept.
// =============================================================================

/**
 * Deep-walk a normalized-then-JSON-round-tripped workflow and collect every
 * step-shaped object (`{ name, ... }`) that carries a `ui`, keyed by step name.
 * Structure-agnostic so the assertion survives where exactly the normalizer
 * nests inner steps (branch conditions, forEach/loop `steps`, switch cases,
 * tryCatch try/catch/finally).
 */
function collectUiByName(node: unknown, out: Map<string, unknown>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectUiByName(item, out);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	if (typeof obj.name === "string" && "ui" in obj) out.set(obj.name, obj.ui);
	for (const value of Object.values(obj)) collectUiByName(value, out);
}

describe("WorkflowNormalizer — ui round-trip (#301/#302)", () => {
	// One workflow exercising `ui` on every step kind at the top level PLUS a
	// nested step inside each nesting context (branch arm, forEach body, switch
	// case, tryCatch arm), incl. a passthrough `color` key and a deeply-nested
	// forEach-inside-branch.
	const wf = {
		name: "UI RoundTrip",
		version: "1.0.0",
		trigger: { http: { method: "POST", path: "/ui" } },
		steps: [
			// regular (top level) + passthrough extra key
			{ id: "reg", use: "@blokjs/respond", inputs: {}, ui: { x: 1, y: 2, notes: "regular", color: "red" } },
			// branch — ui on the branch step AND on a step in each arm; the else
			// arm nests a forEach whose body step also carries ui (deeply nested).
			{
				id: "br",
				branch: {
					when: "ctx.req.method === 'POST'",
					then: [{ id: "thenStep", use: "@blokjs/respond", inputs: {}, ui: { x: 10, notes: "then arm" } }],
					else: [
						{
							id: "feInBranch",
							forEach: {
								in: "js/ctx.state.reg",
								as: "row",
								do: [{ id: "deep", use: "@blokjs/respond", inputs: {}, ui: { notes: "forEach inside branch" } }],
							},
							ui: { notes: "nested forEach" },
						},
					],
				},
				ui: { x: 20, notes: "branch step" },
			},
			// subworkflow (top level)
			{ id: "sub", subworkflow: "child", inputs: {}, ui: { notes: "subworkflow step" } },
			// wait (top level)
			{ id: "wait1", wait: { for: "1s" }, ui: { notes: "wait step" } },
			// forEach (top level) with a ui-bearing body step
			{
				id: "fe",
				forEach: {
					in: "js/ctx.state.reg",
					as: "item",
					do: [{ id: "feBody", use: "@blokjs/respond", inputs: {}, ui: { notes: "forEach body" } }],
				},
				ui: { notes: "forEach step" },
			},
			// loop (top level) with a ui-bearing body step
			{
				id: "lp",
				loop: {
					while: "false",
					do: [{ id: "lpBody", use: "@blokjs/respond", inputs: {}, ui: { notes: "loop body" } }],
				},
				ui: { notes: "loop step" },
			},
			// switch (top level) with a ui-bearing case step
			{
				id: "sw",
				switch: {
					on: "js/ctx.state.reg",
					cases: [
						{ when: "a", do: [{ id: "caseStep", use: "@blokjs/respond", inputs: {}, ui: { notes: "switch case" } }] },
					],
					default: [{ id: "defStep", use: "@blokjs/respond", inputs: {}, ui: { notes: "switch default" } }],
				},
				ui: { notes: "switch step" },
			},
			// tryCatch (top level) with ui-bearing try/catch/finally steps
			{
				id: "tc",
				tryCatch: {
					try: [{ id: "tryStep", use: "@blokjs/respond", inputs: {}, ui: { notes: "try arm" } }],
					catch: [{ id: "catchStep", use: "@blokjs/respond", inputs: {}, ui: { notes: "catch arm" } }],
					finally: [{ id: "finallyStep", use: "@blokjs/respond", inputs: {}, ui: { notes: "finally arm" } }],
				},
				ui: { notes: "tryCatch step" },
			},
			// step with ui AND as — ui must not interfere with as/spread handling
			{ id: "withAs", use: "@blokjs/respond", inputs: {}, as: "renamed", ui: { notes: "with as" } },
		],
	};

	// Every (stepName -> ui) the workflow declares, top-level + nested.
	const expectedUi: Record<string, unknown> = {
		reg: { x: 1, y: 2, notes: "regular", color: "red" },
		br: { x: 20, notes: "branch step" },
		thenStep: { x: 10, notes: "then arm" },
		feInBranch: { notes: "nested forEach" },
		deep: { notes: "forEach inside branch" },
		sub: { notes: "subworkflow step" },
		wait1: { notes: "wait step" },
		fe: { notes: "forEach step" },
		feBody: { notes: "forEach body" },
		lp: { notes: "loop step" },
		lpBody: { notes: "loop body" },
		sw: { notes: "switch step" },
		caseStep: { notes: "switch case" },
		defStep: { notes: "switch default" },
		tc: { notes: "tryCatch step" },
		tryStep: { notes: "try arm" },
		catchStep: { notes: "catch arm" },
		finallyStep: { notes: "finally arm" },
		withAs: { notes: "with as" },
	};

	it("preserves ui byte-identical after IR → normalize → toJson → parse for every step kind incl. nested arms", () => {
		const normalized = normalizeWorkflow(wf, "ui-roundtrip.json");
		// toJson round-trip — the canvas serializes the normalized IR back out.
		const roundTripped = JSON.parse(JSON.stringify(normalized));

		const found = new Map<string, unknown>();
		collectUiByName(roundTripped, found);

		for (const [name, ui] of Object.entries(expectedUi)) {
			expect(found.has(name), `ui missing for step "${name}" after round-trip`).toBe(true);
			expect(found.get(name), `ui mismatch for step "${name}"`).toEqual(ui);
		}
	});

	it("with-as step keeps ui and still renames its output key", () => {
		const out = normalizeWorkflow(wf, "ui-roundtrip.json");
		const withAs = out.steps.find((s) => s.name === "withAs");
		expect(withAs?.as).toBe("renamed");
		expect(withAs?.ui).toEqual({ notes: "with as" });
	});

	it("omits ui entirely when a step declares none", () => {
		const out = normalizeWorkflow(
			{
				name: "NoUi",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/noui" } },
				steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
			},
			"noui.json",
		);
		expect("ui" in out.steps[0]).toBe(false);
	});
});

// =============================================================================
// Issue #713 — per-step `description` survives IR → normalize → toJson for every
// step kind, incl. nested arms. Same defect class as `ui` (#300/#301) and
// deliberately the same test shape: PR #711 added `description` to all 8 v2
// step schemas, but the normalizer dropped it, so a Studio open → save lost
// every step description the author had written.
// =============================================================================

/** Deep-walk a round-tripped workflow, collecting `description` by step name. */
function collectDescriptionByName(node: unknown, out: Map<string, unknown>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectDescriptionByName(item, out);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	if (typeof obj.name === "string" && "description" in obj) out.set(obj.name, obj.description);
	for (const value of Object.values(obj)) collectDescriptionByName(value, out);
}

describe("WorkflowNormalizer — per-step description round-trip (#713)", () => {
	const wf = {
		name: "Description RoundTrip",
		version: "1.0.0",
		description: "workflow-level description — must not be confused with a step's",
		trigger: { http: { method: "POST", path: "/desc" } },
		steps: [
			{ id: "reg", use: "@blokjs/respond", inputs: {}, description: "regular step" },
			{
				id: "br",
				branch: {
					when: "ctx.req.method === 'POST'",
					then: [{ id: "thenStep", use: "@blokjs/respond", inputs: {}, description: "then arm" }],
					else: [
						{
							id: "feInBranch",
							forEach: {
								in: "js/ctx.state.reg",
								as: "row",
								do: [{ id: "deep", use: "@blokjs/respond", inputs: {}, description: "forEach inside branch" }],
							},
							description: "nested forEach",
						},
					],
				},
				description: "branch step",
			},
			{ id: "sub", subworkflow: "child", inputs: {}, description: "subworkflow step" },
			{ id: "wait1", wait: { for: "1s" }, description: "wait step" },
			{
				id: "fe",
				forEach: {
					in: "js/ctx.state.reg",
					as: "item",
					do: [{ id: "feBody", use: "@blokjs/respond", inputs: {}, description: "forEach body" }],
				},
				description: "forEach step",
			},
			{
				id: "lp",
				loop: { while: "false", do: [{ id: "lpBody", use: "@blokjs/respond", inputs: {}, description: "loop body" }] },
				description: "loop step",
			},
			{
				id: "sw",
				switch: {
					on: "js/ctx.state.reg",
					cases: [
						{ when: "a", do: [{ id: "caseStep", use: "@blokjs/respond", inputs: {}, description: "switch case" }] },
					],
					default: [{ id: "defStep", use: "@blokjs/respond", inputs: {}, description: "switch default" }],
				},
				description: "switch step",
			},
			{
				id: "tc",
				tryCatch: {
					try: [{ id: "tryStep", use: "@blokjs/respond", inputs: {}, description: "try arm" }],
					catch: [{ id: "catchStep", use: "@blokjs/respond", inputs: {}, description: "catch arm" }],
					finally: [{ id: "finallyStep", use: "@blokjs/respond", inputs: {}, description: "finally arm" }],
				},
				description: "tryCatch step",
			},
			{ id: "withAs", use: "@blokjs/respond", inputs: {}, as: "renamed", description: "with as" },
		],
	};

	const expectedDescriptions: Record<string, string> = {
		reg: "regular step",
		br: "branch step",
		thenStep: "then arm",
		feInBranch: "nested forEach",
		deep: "forEach inside branch",
		sub: "subworkflow step",
		wait1: "wait step",
		fe: "forEach step",
		feBody: "forEach body",
		lp: "loop step",
		lpBody: "loop body",
		sw: "switch step",
		caseStep: "switch case",
		defStep: "switch default",
		tc: "tryCatch step",
		tryStep: "try arm",
		catchStep: "catch arm",
		finallyStep: "finally arm",
		withAs: "with as",
	};

	it("preserves description after IR → normalize → toJson → parse for every step kind incl. nested arms", () => {
		const normalized = normalizeWorkflow(wf, "description-roundtrip.json");
		const roundTripped = JSON.parse(JSON.stringify(normalized));

		const found = new Map<string, unknown>();
		collectDescriptionByName(roundTripped, found);

		for (const [name, description] of Object.entries(expectedDescriptions)) {
			expect(found.has(name), `description missing for step "${name}" after round-trip`).toBe(true);
			expect(found.get(name), `description mismatch for step "${name}"`).toBe(description);
		}
	});

	it("keeps the workflow-level description separate from every step's", () => {
		const out = normalizeWorkflow(wf, "description-roundtrip.json");
		expect(out.description).toBe("workflow-level description — must not be confused with a step's");
		expect(out.steps.find((s) => s.name === "reg")?.description).toBe("regular step");
	});

	it("omits description entirely when a step declares none", () => {
		const out = normalizeWorkflow({
			name: "NoDescription",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/nodesc" } },
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		});
		expect("description" in out.steps[0]).toBe(false);
	});

	it("ignores a non-string description rather than emitting one", () => {
		const out = normalizeWorkflow({
			name: "BadDescription",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/bad" } },
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {}, description: { not: "a string" } }],
		});
		expect("description" in out.steps[0]).toBe(false);
	});
});

// =============================================================================
// Studio debug controls — active:false (Skip) / stop:true (Stop) survive
// normalization. Unlike `ui` / `description` (copyStepMeta — optional
// passthrough, omitted when absent), active/stop are NOT optional
// passthrough fields: every
// InternalStep constructor already stamps a default (`active: true`,
// `stop: false`) even when the raw step declares neither — see the
// `active: step.active === undefined ? true : Boolean(step.active)` /
// `stop: step.stop === true` lines repeated across every step-kind builder
// in WorkflowNormalizer.ts. That predates the Studio canvas work, so no
// normalizer change was needed for the Skip/Stop toggles — this is
// regression coverage proving it, per RunnerSteps.runSteps' loop
// (core/runner/CLAUDE.md "Step Execution Flow"): `if (!step.active) …
// continue` runs BEFORE `if (step.stop) break`.
// =============================================================================
describe("WorkflowNormalizer — active:false / stop:true survive normalization", () => {
	it("keeps active:false on a regular step", () => {
		const out = normalizeWorkflow(
			{
				name: "ActiveFalse",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [{ id: "a", use: "@blokjs/respond", inputs: {}, active: false }],
			},
			"active-false.json",
		);
		expect(out.steps[0].active).toBe(false);
	});

	it("keeps stop:true on a regular step", () => {
		const out = normalizeWorkflow(
			{
				name: "StopTrue",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [{ id: "a", use: "@blokjs/respond", inputs: {}, stop: true }],
			},
			"stop-true.json",
		);
		expect(out.steps[0].stop).toBe(true);
	});

	it("defaults to active:true / stop:false when neither is declared", () => {
		const out = normalizeWorkflow(
			{
				name: "Defaults",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/d" } },
				steps: [{ id: "a", use: "@blokjs/respond", inputs: {} }],
			},
			"defaults.json",
		);
		expect(out.steps[0].active).toBe(true);
		expect(out.steps[0].stop).toBe(false);
	});

	it("keeps the flags on branch/forEach container steps (per-step, not just leaf steps)", () => {
		const out = normalizeWorkflow(
			{
				name: "ContainersFlags",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/c" } },
				steps: [
					{
						id: "br",
						branch: {
							when: "ctx.req.method === 'POST'",
							then: [{ id: "t1", use: "@blokjs/respond", inputs: {} }],
						},
						active: false,
					},
					{
						id: "fe",
						forEach: { in: "js/ctx.state.br", as: "row", do: [{ id: "feBody", use: "@blokjs/respond", inputs: {} }] },
						stop: true,
					},
				],
			},
			"containers-flags.json",
		);
		expect(out.steps.find((s) => s.name === "br")?.active).toBe(false);
		expect(out.steps.find((s) => s.name === "fe")?.stop).toBe(true);
	});

	// The Studio definition-PUT endpoint (`writeWorkflowDefinition`) calls
	// `normalizeWorkflow` purely as a load-time validation gate before
	// persisting the RAW definition verbatim — it never rejects unknown-but-
	// typed step fields. Same tolerance `ui` already relies on.
	it("does not reject a step carrying active/stop/ui together (PUT-validation tolerance)", () => {
		expect(() =>
			normalizeWorkflow({
				name: "Tolerated",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/t" } },
				steps: [{ id: "a", use: "@blokjs/respond", inputs: {}, active: false, stop: false, ui: { x: 1, y: 2 } }],
			}),
		).not.toThrow();
	});
});

// #704 — `wait.for` / `wait.until` take a literal (parsed HERE, at load time)
// or a reference (lowered here, resolved by RunnerSteps against the live ctx
// when the step runs). The literal path must stay byte-identical.
describe("WorkflowNormalizer — wait references (#704)", () => {
	const waitStep = (wait: unknown) =>
		normalizeWorkflow({
			name: "Waits",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/w" } },
			steps: [{ id: "pause", wait }],
		}).steps[0] as unknown as {
			waitForMs?: number;
			waitUntil?: number | string;
			waitForExpr?: string;
			waitUntilExpr?: string;
		};

	it("keeps the literal fast path: a duration string is still parsed at load time", () => {
		const step = waitStep({ for: "5m" });
		expect(step.waitForMs).toBe(300_000);
		expect(step.waitForExpr).toBeUndefined();
	});

	it("keeps the literal fast path: an ISO `until` is still carried verbatim", () => {
		const step = waitStep({ until: "2026-01-01T09:00:00Z" });
		expect(step.waitUntil).toBe("2026-01-01T09:00:00Z");
		expect(step.waitUntilExpr).toBeUndefined();
	});

	it("lowers a structural {$ref} in `wait.for` to the wire expression", () => {
		const step = waitStep({ for: { $ref: { step: "compute-delay", path: [] } } });
		expect(step.waitForExpr).toBe('js/ctx.state["compute-delay"]');
		expect(step.waitForMs).toBeUndefined();
	});

	it("lowers a structural {$ref} in `wait.until`, including a path", () => {
		const step = waitStep({ until: { $ref: { step: "@trigger", path: ["body", "scheduledAt"] } } });
		expect(step.waitUntilExpr).toBe("js/ctx.request.body.scheduledAt");
		expect(step.waitUntil).toBeUndefined();
	});

	it("carries a hand-written `js/` escape hatch through as an expression", () => {
		const step = waitStep({ for: "js/ctx.state.retryAfter * 1000" });
		expect(step.waitForExpr).toBe("js/ctx.state.retryAfter * 1000");
		expect(step.waitForMs).toBeUndefined();
	});

	// The shape that motivated #704: the broken example wrote a proxy path here,
	// and #703's lexical sweep rewrote it into an equally-dead form. Neither is a
	// duration, so neither may be accepted as a literal.
	//
	// The proxy fixtures are CONCATENATED so this file doesn't contain the
	// deleted `$` proxy shape contiguously — `scripts/check-no-dollar-proxy.sh`
	// greps the whole repo for it and takes no arguments about intent.
	const PROXY = "$";
	it.each([
		["a proxy path", `${PROXY}.state['compute-delay']`],
		["a bare ctx expression", "ctx.state.delay"],
		["an interpolation", "${ctx.state.delay}"],
	])("refuses %s at LOAD time, naming the step and the field", (_label, value) => {
		expect(() => waitStep({ for: value })).toThrow(/`wait\.for` on wait step "pause"/);
	});

	it("refuses the same shapes in `wait.until`", () => {
		expect(() => waitStep({ until: `${PROXY}.request.body.deadline` })).toThrow(/`wait\.until` on wait step "pause"/);
	});

	// The showcase fixture is a docs-only file the runner never loads, which is
	// exactly how it shipped a computed backoff that could never have worked
	// (#704). Loading it HERE is what stops it from being a place broken claims
	// can hide: if the wait reference ever stops lowering, this goes red.
	it("loads the shipped polling-with-backoff example, wait reference and all", () => {
		const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
		const doc = JSON.parse(
			readFileSync(path.join(repoRoot, "examples/v05-primitives/09-polling-with-backoff.json"), "utf8"),
		);

		const out = normalizeWorkflow(doc, "09-polling-with-backoff.json");

		const loopBody = (
			out.nodes["poll-with-backoff"] as unknown as { steps: Array<{ name: string; waitForExpr?: string }> }
		).steps;
		expect(loopBody.find((s) => s.name === "wait-backoff")?.waitForExpr).toBe('js/ctx.state["compute-delay"]');
	});
});
