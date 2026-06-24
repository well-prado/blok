import { describe, expect, it } from "vitest";
import { z } from "zod";
import { $, branch, workflow } from "../src/index";
import { JS_EXPR_TAG, type V2Step, unwrapProxies } from "../src/internal";

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

describe("v2 DSL — workflow() output/events typing metadata (P1.1)", () => {
	const In = z.object({ q: z.string().optional() });
	const Out = z.object({ users: z.array(z.string()), total: z.number() });

	it("carries input + output Zod schemas verbatim on _config", () => {
		const wf = workflow({
			name: "Typed",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			input: In,
			output: Out,
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		});
		expect((wf._config as { input?: unknown }).input).toBe(In);
		expect((wf._config as { output?: unknown }).output).toBe(Out);
	});

	it("carries an events vocabulary verbatim on _config", () => {
		const events = { progress: z.object({ pct: z.number() }), done: z.object({ ok: z.boolean() }) };
		const wf = workflow({
			name: "Streamy",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			events,
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		});
		expect((wf._config as { events?: unknown }).events).toBe(events);
	});

	it("omits output/events from _config when not declared", () => {
		const wf = workflow({
			name: "Plain",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		});
		expect("output" in wf._config).toBe(false);
		expect("events" in wf._config).toBe(false);
	});

	it("strips input/output/events from toJson() (Zod schemas aren't serializable)", () => {
		const wf = workflow({
			name: "Typed",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			input: In,
			output: Out,
			events: { done: z.object({ ok: z.boolean() }) },
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		});
		const json = JSON.parse(wf.toJson()) as Record<string, unknown>;
		expect(json.input).toBeUndefined();
		expect(json.output).toBeUndefined();
		expect(json.events).toBeUndefined();
		expect(json.name).toBe("Typed");
	});
});

describe("v2 DSL — workflow() phantom types (P1.2)", () => {
	it("does not add a runtime __blokTypes field (the type witness is compile-time only)", () => {
		const wf = workflow({
			name: "Typed",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			input: z.object({ q: z.string() }),
			output: z.object({ users: z.array(z.string()), total: z.number() }),
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		});
		// The witness exists only at the type level — never on the runtime object,
		// so it can't leak into the registry, serialization, or the normalizer.
		expect("__blokTypes" in wf).toBe(false);
		// …and it's still a valid v2 builder (registry/loader drop-in).
		expect(wf._blokV2).toBe(true);
		expect(wf._config.name).toBe("Typed");
	});

	// Compile-time intent (documentation; this file is type-checked when `tsc`
	// runs over the package). If the phantom inference regresses, the client
	// package's `Client<BlokApp>` build is the CI-enforced guard.
	it("infers input/output onto the typed return", () => {
		const wf = workflow({
			name: "Typed",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			input: z.object({ q: z.string() }),
			output: z.object({ total: z.number() }),
			steps: [{ id: "x", use: "@blokjs/respond", inputs: {} }],
		});
		type Witness = NonNullable<(typeof wf)["__blokTypes"]>;
		const _out: Witness["output"] = { total: 1 };
		const _in: Witness["input"] = { q: "ada" };
		expect(_out.total).toBe(1);
		expect(_in.q).toBe("ada");
	});
});

describe("v2 DSL — workflow() typed streaming events validation (P3.3)", () => {
	const events = { progress: z.object({ pct: z.number() }), done: z.object({ ok: z.boolean() }) };

	it("accepts a workflow whose sse-emit events are all declared", () => {
		expect(() =>
			workflow({
				name: "Streamy",
				version: "1.0.0",
				trigger: { http: { method: "POST" } },
				events,
				steps: [
					{ id: "p", use: "@blokjs/sse-emit", inputs: { event: "progress", data: { pct: 1 } }, ephemeral: true },
					{ id: "d", use: "@blokjs/sse-emit", inputs: { event: "done", data: { ok: true } }, ephemeral: true },
				],
			}),
		).not.toThrow();
	});

	it("throws when an sse-emit step emits an UNDECLARED event", () => {
		expect(() =>
			workflow({
				name: "Drift",
				version: "1.0.0",
				trigger: { http: { method: "POST" } },
				events,
				steps: [{ id: "x", use: "@blokjs/sse-emit", inputs: { event: "porgress", data: {} }, ephemeral: true }],
			}),
		).toThrow(/porgress.*not declared|not declared.*porgress/i);
	});

	it("catches an undeclared emit nested inside a branch arm", () => {
		expect(() =>
			workflow({
				name: "NestedDrift",
				version: "1.0.0",
				trigger: { http: { method: "POST" } },
				events,
				steps: [
					branch({
						id: "route",
						when: "true",
						then: [{ id: "e", use: "@blokjs/sse-emit", inputs: { event: "unknown", data: {} }, ephemeral: true }],
					}),
				],
			}),
		).toThrow(/not declared/i);
	});

	it("does NOT validate when no events vocabulary is declared", () => {
		expect(() =>
			workflow({
				name: "Untyped",
				version: "1.0.0",
				trigger: { http: { method: "POST" } },
				steps: [{ id: "x", use: "@blokjs/sse-emit", inputs: { event: "anything", data: {} }, ephemeral: true }],
			}),
		).not.toThrow();
	});

	it("skips js/ mapper-expression event names (can't be checked statically)", () => {
		expect(() =>
			workflow({
				name: "DynamicEvent",
				version: "1.0.0",
				trigger: { http: { method: "POST" } },
				events,
				steps: [
					{ id: "x", use: "@blokjs/sse-emit", inputs: { event: "js/ctx.req.body.kind", data: {} }, ephemeral: true },
				],
			}),
		).not.toThrow();
	});
});

describe("v2 DSL — workflow() with idempotencyKey + retry", () => {
	it("preserves a literal idempotencyKey on the compiled step", () => {
		const wf = workflow({
			name: "Idem",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "fetch",
					use: "@blokjs/api-call",
					inputs: { url: "https://example.com" },
					idempotencyKey: "static-key",
					idempotencyKeyTTL: 60_000,
				},
			],
		});
		const step = wf._config.steps[0] as { idempotencyKey: string; idempotencyKeyTTL: number };
		expect(step.idempotencyKey).toBe("static-key");
		expect(step.idempotencyKeyTTL).toBe(60_000);
	});

	it("compiles a $ proxy idempotencyKey to its js/ctx string at definition time", () => {
		const wf = workflow({
			name: "Idem",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "fetch",
					use: "@blokjs/api-call",
					inputs: { url: "https://example.com" },
					idempotencyKey: $.req.body.requestId as unknown as string,
				},
			],
		});
		const step = wf._config.steps[0] as { idempotencyKey: string };
		expect(step.idempotencyKey).toBe("js/ctx.req.body.requestId");
	});

	it("preserves a retry block on the compiled step", () => {
		const wf = workflow({
			name: "Retried",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "flaky",
					use: "@blokjs/api-call",
					inputs: { url: "https://example.com" },
					retry: { maxAttempts: 4, minTimeoutInMs: 250, factor: 3 },
				},
			],
		});
		const step = wf._config.steps[0] as { retry: { maxAttempts: number; minTimeoutInMs: number; factor: number } };
		expect(step.retry.maxAttempts).toBe(4);
		expect(step.retry.minTimeoutInMs).toBe(250);
		expect(step.retry.factor).toBe(3);
	});

	it("rejects retry config with maxAttempts out of range", () => {
		expect(() =>
			workflow({
				name: "Bad",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ id: "x", use: "@blokjs/foo", retry: { maxAttempts: 0 } }],
			}),
		).toThrow();

		expect(() =>
			workflow({
				name: "Bad",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ id: "x", use: "@blokjs/foo", retry: { maxAttempts: 99 } }],
			}),
		).toThrow();
	});

	it("rejects an empty idempotencyKey via the workflow factory", () => {
		expect(() =>
			workflow({
				name: "Bad",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ id: "x", use: "@blokjs/foo", idempotencyKey: "" }],
			}),
		).toThrow();
	});
});

describe("v2 DSL — workflow() with sub-workflow steps", () => {
	it("accepts a minimal sub-workflow step (id + subworkflow)", () => {
		const wf = workflow({
			name: "Parent",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "call-child", subworkflow: "send-receipt" }],
		});
		const step = wf._config.steps[0] as { id: string; subworkflow: string };
		expect(step.id).toBe("call-child");
		expect(step.subworkflow).toBe("send-receipt");
	});

	it("compiles $ proxy expressions inside sub-workflow inputs", () => {
		const wf = workflow({
			name: "Parent",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "notify",
					subworkflow: "send-email",
					inputs: { to: $.req.body.email, subject: $.state.subject },
				},
			],
		});
		const step = wf._config.steps[0] as { inputs: Record<string, unknown> };
		expect(step.inputs.to).toBe("js/ctx.req.body.email");
		expect(step.inputs.subject).toBe("js/ctx.state.subject");
	});

	it("threads idempotencyKey + retry onto a sub-workflow step", () => {
		const wf = workflow({
			name: "Cached parent",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "expensive",
					subworkflow: "llm-pipeline",
					inputs: { topic: $.req.body.topic },
					idempotencyKey: $.req.body.requestId as unknown as string,
					retry: { maxAttempts: 3 },
				},
			],
		});
		const step = wf._config.steps[0] as {
			idempotencyKey: string;
			retry: { maxAttempts: number };
		};
		expect(step.idempotencyKey).toBe("js/ctx.req.body.requestId");
		expect(step.retry.maxAttempts).toBe(3);
	});

	it("accepts wait: false at workflow load time (fire-and-forget)", () => {
		const wf = workflow({
			name: "WithFireAndForget",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "bg", subworkflow: "child", wait: false }],
		});
		const step = wf._config.steps[0] as { wait: boolean };
		expect(step.wait).toBe(false);
	});

	it("rejects empty subworkflow name", () => {
		expect(() =>
			workflow({
				name: "Bad",
				version: "1.0.0",
				trigger: { http: { method: "POST" } },
				steps: [{ id: "bg", subworkflow: "" }],
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
