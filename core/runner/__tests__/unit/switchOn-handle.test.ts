/**
 * switchOn(discriminant, { cases: [{ when, do }], default? }, opts?) over handles
 * (#319 — callback-style switch over the cornerstone).
 *
 * Proves the full authoring → IR → real-engine path:
 *
 *  (a) the discriminant handle lowers to the switch `on` expression as a
 *      `js/ctx.state...` (or `js/ctx.request...`) STRING — the SAME way forEach
 *      lowers its `in` (the normalizer passes `on` verbatim; SwitchNode resolves
 *      it via the Mapper at run time).
 *  (b) each case `do` (+ default) is a callback pushing a CHILD builder scope;
 *      `step()` inside registers into that arm's sub-pipeline.
 *  (c) booted through the REAL Configuration + SwitchNode + Runner: over kind="a"
 *      the "a" case runs, over kind="b" the "b" case runs, and no-match runs default.
 *
 * Plus #319's core acceptance: a handle passed as a case `when` is REJECTED at
 * author time (case labels must be static literals), and the cornerstone
 * cross-arm guard rejects a per-arm handle read from a sibling arm.
 *
 * SCOPE: switch only.
 */

import type { Context, NodeBase, ResponseContext } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Configuration from "../../src/Configuration";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { defineNode } from "../../src/defineNode";
import { type TriggerHandle, js, step, switchOn, workflowCallback } from "../../src/stepBuilder";
import type GlobalOptions from "../../src/types/GlobalOptions";

const noop = defineNode({
	name: "noop",
	description: "passthrough used only for its output type in author-time tests",
	input: z.object({}).passthrough(),
	output: z.record(z.unknown()),
	execute: (_ctx, input) => input as Record<string, unknown>,
});

// ───────────────────────── (a)+(b): IR-shape assertions ─────────────────────

describe("switchOn — IR lowering (#319)", () => {
	it("lowers the discriminant to a js/ctx.state `on` string and each arm `do` to a sub-pipeline", async () => {
		const wf = await workflowCallback("Route", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const validate = step("validate", noop, {});
			switchOn(
				validate.kind,
				{
					cases: [
						{
							when: "a",
							do: () => {
								step("doA", noop, { tag: "A" });
							},
						},
						{
							when: ["b", "c"],
							do: () => {
								step("doBC", noop, { tag: "BC" });
							},
						},
					],
					default: () => {
						step("fallback", noop, { tag: "D" });
					},
				},
				{ id: "route" },
			);
		});

		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const sw = steps.find((s) => s.switch) as {
			id: string;
			switch: {
				on: string;
				cases: Array<{ when: unknown; do: Array<Record<string, unknown>> }>;
				default?: Array<Record<string, unknown>>;
			};
		};

		// (a) `on` is the lowered wire string — NOT a {$ref}, NOT a $. proxy.
		expect(sw.switch.on).toBe("js/ctx.state.validate.kind");
		expect(typeof sw.switch.on).toBe("string");
		expect(sw.id).toBe("route");

		// (b) literal `when` values pass through verbatim; each arm `do` is a pipeline.
		expect(sw.switch.cases[0].when).toBe("a");
		expect(sw.switch.cases[0].do.map((s) => s.id)).toEqual(["doA"]);
		expect(sw.switch.cases[1].when).toEqual(["b", "c"]);
		expect(sw.switch.cases[1].do.map((s) => s.id)).toEqual(["doBC"]);
		expect(sw.switch.default?.map((s) => s.id)).toEqual(["fallback"]);
	});

	it("derives a switch id from the discriminant when opts.id is omitted; trigger field → ctx.request", async () => {
		const wf = await workflowCallback(
			"Derived",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				switchOn(req.body.kind, {
					cases: [
						{
							when: 1,
							do: () => {
								step("one", noop, {});
							},
						},
					],
				});
			},
		);
		const sw = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.switch) as {
			id: string;
			switch: { on: string };
		};
		expect(sw.switch.on).toBe("js/ctx.request.body.kind");
		expect(sw.id).toBe("kindSwitch");
	});

	// #647 — a js`…` escape lets the discriminant be a COMPUTED expression no bare
	// handle can express (case-fold, defaulting, method calls). It lowers to the
	// same `js/…` wire string the runner's Mapper resolves for `on`.
	it("accepts a js`…` computed discriminant, lowering `on` verbatim (#647)", async () => {
		const wf = await workflowCallback(
			"Route",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				switchOn(
					js`(${req.body.type} || 'unknown').toLowerCase()`,
					{
						cases: [
							{
								when: "issue",
								do: () => {
									step("doIssue", noop, {});
								},
							},
						],
						default: () => {
							step("fallback", noop, {});
						},
					},
					{ id: "route-by-type" },
				);
			},
		);
		const sw = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.switch) as {
			id: string;
			switch: { on: string; cases: Array<{ when: unknown }> };
		};
		expect(sw.switch.on).toBe("js/(ctx.request.body.type || 'unknown').toLowerCase()");
		expect(sw.id).toBe("route-by-type");
		expect(sw.switch.cases[0].when).toBe("issue");
	});

	it("rejects a js`…` discriminant without an explicit { id } (#647)", async () => {
		await expect(
			workflowCallback("NoId", { version: "1.0.0", trigger: { http: { method: "POST" } } }, (req: TriggerHandle) => {
				switchOn(js`(${req.body.type} || '').toLowerCase()`, {
					cases: [
						{
							when: "x",
							do: () => {
								step("x", noop, {});
							},
						},
					],
				});
			}),
		).rejects.toThrow(/requires an explicit \{ id \}/);
	});

	it("rejects a raw string discriminant that isn't from js`…` (#647)", async () => {
		await expect(
			workflowCallback("BadStr", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				switchOn("ctx.request.body.type" as unknown as string, {
					cases: [
						{
							when: "x",
							do: () => {
								step("x", noop, {});
							},
						},
					],
				});
			}),
		).rejects.toThrow(/must come from the js/);
	});
});

// ───────────────────── #319 acceptance: handle `when` rejected ──────────────

describe("switchOn — case `when` must be a static literal (#319)", () => {
	it("rejects a handle passed as a case `when`", async () => {
		await expect(
			workflowCallback("HandleWhen", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const v = step("validate", noop, {});
				switchOn(v.kind, {
					// a handle as a case label can never `=== on` — reject at author time.
					cases: [
						{
							when: v.other as unknown as string,
							do: () => {
								step("x", noop, {});
							},
						},
					],
				});
			}),
		).rejects.toThrow(/case label must be a STATIC literal/);
	});

	it("rejects a handle ELEMENT inside an array `when`", async () => {
		await expect(
			workflowCallback("HandleWhenArr", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const v = step("validate", noop, {});
				switchOn(v.kind, {
					cases: [
						{
							when: ["a", v.other as unknown as string],
							do: () => {
								step("x", noop, {});
							},
						},
					],
				});
			}),
		).rejects.toThrow(/case label must be a STATIC literal/);
	});

	it("rejects a per-arm handle read from a SIBLING arm (cornerstone canRead)", async () => {
		await expect(
			workflowCallback("SiblingLeak", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const v = step("validate", noop, {});
				let leaked: ReturnType<typeof step> | undefined;
				switchOn(
					v.kind,
					{
						cases: [
							{
								when: "a",
								do: () => {
									leaked = step("a1", noop, {});
								},
							},
							// reading the FIRST arm's handle from the SECOND arm's body must throw.
							{
								when: "b",
								do: () => {
									step("b1", noop, { x: (leaked as { stray: unknown }).stray });
								},
							},
						],
					},
					{ id: "route" },
				);
			}),
		).rejects.toThrow(/outside its scope/);
	});
});

// ───────────────────── (c): real Configuration + SwitchNode + Runner ────────

class CtxPublishNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/ctx-publish";
		this.node = "@blokjs/ctx-publish";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as {
			inputs?: { name?: string; value?: unknown };
		};
		const name = opts.inputs?.name ?? "";
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		state[name] = opts.inputs?.value;
		return { success: true, data: { name, value: opts.inputs?.value }, error: null };
	}
}

async function bootAndRun(workflowDef: unknown, kind: unknown): Promise<Record<string, unknown>> {
	const config = new Configuration();
	const helpers: Record<string, RunnerNode> = {
		"@blokjs/ctx-publish": new CtxPublishNode(),
	};
	const globalOptions = {
		nodes: { getNode: (name: string): RunnerNode | null => helpers[name] ?? null },
	} as unknown as GlobalOptions;
	await config.init("switch-e2e", globalOptions, workflowDef);
	const state: Record<string, unknown> = {};
	const ctx = {
		id: "req",
		workflow_name: "switch-e2e",
		workflow_path: "/x",
		request: { body: { kind }, headers: {}, params: {}, query: {} },
		response: { data: null, success: true, error: null, contentType: "application/json" },
		error: { message: [] },
		logger: {
			log: () => {},
			logLevel: () => {},
			error: () => {},
			getLogs: () => [],
			getLogsAsText: () => "",
			getLogsAsBase64: () => "",
		},
		config: config.nodes,
		vars: state,
		state,
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
	await new Runner(config.steps as NodeBase[]).run(ctx);
	return ctx.state as Record<string, unknown>;
}

describe("switchOn — real Configuration + SwitchNode + Runner", () => {
	// Author the switch via the handle DSL once, then run THAT IR over different
	// discriminant values (the `on` reads ctx.state.seed.kind, seeded per run).
	async function authoredDef(): Promise<unknown> {
		const wf = await workflowCallback("Route", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const seed = step("seed", noop, {});
			switchOn(
				seed.kind,
				{
					cases: [
						{
							when: "a",
							do: () => {
								step("markA", noop, {});
							},
						},
						{
							when: "b",
							do: () => {
								step("markB", noop, {});
							},
						},
					],
					default: () => {
						step("markDefault", noop, {});
					},
				},
				{ id: "route" },
			);
		});
		const sw = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.switch) as {
			switch: { on: string };
		};
		// Sanity: authored `on` is the lowered wire string.
		expect(sw.switch.on).toBe("js/ctx.state.seed.kind");

		return {
			name: "switch-e2e",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				// seed state.seed = { kind } from the request body.
				{
					id: "seed",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "seed", value: { kind: "js/ctx.request.body.kind" } },
				},
				{
					id: "route",
					switch: {
						on: sw.switch.on,
						cases: [
							{
								when: "a",
								do: [{ id: "markA", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "ran", value: "A" } }],
							},
							{
								when: "b",
								do: [{ id: "markB", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "ran", value: "B" } }],
							},
						],
						default: [
							{
								id: "markDefault",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "ran", value: "DEFAULT" },
							},
						],
					},
				},
			],
		};
	}

	it("runs the matching case for kind=a", async () => {
		const state = await bootAndRun(await authoredDef(), "a");
		expect(state.ran).toBe("A");
	});

	it("runs the matching case for kind=b", async () => {
		const state = await bootAndRun(await authoredDef(), "b");
		expect(state.ran).toBe("B");
	});

	it("runs the default when no case matches", async () => {
		const state = await bootAndRun(await authoredDef(), "zzz");
		expect(state.ran).toBe("DEFAULT");
	});

	// #647 — a js`…` COMPUTED discriminant routes correctly at run time: the
	// Mapper resolves the case-fold expression, so a capitalized "Issue" from the
	// webhook body matches the lowercase "issue" case — impossible with a bare
	// handle (which would carry the raw "Issue" and never `=== "issue"`).
	async function computedDef(): Promise<unknown> {
		const wf = await workflowCallback(
			"Route",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				switchOn(
					js`(${req.body.kind} || 'unknown').toLowerCase()`,
					{
						cases: [
							{
								when: "issue",
								do: () => {
									step("markIssue", noop, {});
								},
							},
							{
								when: "comment",
								do: () => {
									step("markComment", noop, {});
								},
							},
						],
						default: () => {
							step("markDefault", noop, {});
						},
					},
					{ id: "route-by-type" },
				);
			},
		);
		const sw = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.switch) as {
			switch: { on: string };
		};
		expect(sw.switch.on).toBe("js/(ctx.request.body.kind || 'unknown').toLowerCase()");
		return {
			name: "switch-e2e",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "route",
					switch: {
						on: sw.switch.on,
						cases: [
							{
								when: "issue",
								do: [
									{
										id: "markIssue",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "ran", value: "ISSUE" },
									},
								],
							},
							{
								when: "comment",
								do: [
									{
										id: "markComment",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "ran", value: "COMMENT" },
									},
								],
							},
						],
						default: [
							{
								id: "markDefault",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "ran", value: "DEFAULT" },
							},
						],
					},
				},
			],
		};
	}

	it("case-folds a capitalized discriminant to match a lowercase case (#647)", async () => {
		expect((await bootAndRun(await computedDef(), "Issue")).ran).toBe("ISSUE");
		expect((await bootAndRun(await computedDef(), "Comment")).ran).toBe("COMMENT");
		expect((await bootAndRun(await computedDef(), "Project")).ran).toBe("DEFAULT");
	});
});
