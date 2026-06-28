/**
 * branch(condition, { then, else }) over handles (#418, ADR 0003/0004).
 *
 * Proves the full authoring → IR → real-engine path:
 *
 *  (a) the emitted IR `branch.when` is a BARE `ctx.state...` string — NOT a
 *      `js/...` string, NOT a `$.` string, NOT a `{$ref}`. (ADR 0004: the
 *      if-else node evals `when` via raw `Function("ctx", ...)`, so a `js/`
 *      prefix would 500 with "js is not defined".)
 *  (b) the then/else arms carry their steps in order, with `{$ref}` inputs.
 *  (c) booted through the REAL Configuration + Runner (the same path switch.test
 *      uses) the correct arm executes and the bare when-string evaluates without
 *      throwing "js is not defined".
 *
 * Plus the cross-arm scope guard (ADR 0003): a handle minted inside `then`,
 * read from `else` OR from a step after the branch, is REJECTED at author time.
 * This is the first test to actually exercise the cornerstone's `canRead` guard
 * — it was dormant under the linear-only #421 PR.
 *
 * SCOPE: branch then/else only. forEach/switch/loop/tryCatch handle-arm
 * integration is later work (#329 etc.).
 */

import type { Context, NodeBase, ResponseContext } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Configuration from "../../src/Configuration";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { defineNode } from "../../src/defineNode";
import {
	type TriggerHandle,
	branch,
	eq,
	gt,
	gte,
	lt,
	lte,
	makeHandle,
	ne,
	step,
	workflowCallback,
} from "../../src/stepBuilder";
import type GlobalOptions from "../../src/types/GlobalOptions";

const noop = defineNode({
	name: "noop",
	description: "passthrough used only for its output type in author-time tests",
	input: z.object({}).passthrough(),
	// `record(unknown)` output so handle field reads (`.inStock`, `.value`, …)
	// type-check in these author-time tests without per-field schemas.
	output: z.record(z.unknown()),
	execute: (_ctx, input) => input as Record<string, unknown>,
});

// Spread requires a statically-known object output (#342) — this node has one.
const spreadable = defineNode({
	name: "spreadable",
	description: "object output so { spread: true } has known keys",
	input: z.object({}).passthrough(),
	output: z.object({ user: z.object({ active: z.boolean() }) }),
	execute: () => ({ user: { active: true } }),
});

// ───────────────────────── (a)+(b): IR-shape assertions ─────────────────────

describe("branch — IR lowering (ADR 0004)", () => {
	it("lowers a boolean-handle condition to a BARE ctx.state when-string", async () => {
		const wf = await workflowCallback("InStock", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			// mint the producing step so the builder records its (default)
			// persistence metadata; the condition reads a field handle off it.
			const s = step("stock", noop, {});
			branch("route", s.inStock, {
				then: () => {
					step("ship", noop, { ok: true });
				},
				else: () => {
					step("backorder", noop, { ok: false });
				},
			});
		});

		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const br = steps.find((s) => s.id === "route") as {
			branch: { when: string; then: Array<Record<string, unknown>>; else: Array<Record<string, unknown>> };
		};

		// (a) BARE ctx.state — not js/, not $, not {$ref}.
		expect(br.branch.when).toBe("ctx.state.stock.inStock");
		expect(br.branch.when).not.toMatch(/^js\//);
		expect(br.branch.when).not.toContain("$");
		expect(typeof br.branch.when).toBe("string");

		// (b) arms carry the right steps with {$ref} inputs.
		expect(br.branch.then.map((s) => s.id)).toEqual(["ship"]);
		expect(br.branch.else.map((s) => s.id)).toEqual(["backorder"]);
		expect(br.branch.then[0].inputs).toEqual({ ok: true });
	});

	it("lowers a typed op (gt over handle fields) to a BARE infix ctx.state string", async () => {
		const wf = await workflowCallback(
			"BigOrder",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const order = step("order", noop, { qty: req.body.qty });
				const limit = step("limit", noop, { max: 10 });
				branch("big", gt(order.qty, limit.max), {
					then: () => {
						step("bulk", noop, { ok: true });
					},
				});
			},
		);
		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const br = steps.find((s) => s.id === "big") as { branch: { when: string; else?: unknown } };
		expect(br.branch.when).toBe("ctx.state.order.qty > ctx.state.limit.max");
		expect(br.branch.when).not.toMatch(/js\//);
		// empty else arm → no `else` key emitted.
		expect(br.branch.else).toBeUndefined();
	});

	it("roots an `as:`-renamed producing step at the renamed state key", async () => {
		const wf = await workflowCallback("Renamed", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const v = step("validate", noop, {}, { as: "order" });
			branch("ok", v.valid, {
				then: () => {
					step("go", noop, {});
				},
			});
		});
		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const br = steps.find((s) => s.id === "ok") as { branch: { when: string } };
		expect(br.branch.when).toBe("ctx.state.order.valid");
	});

	it("roots a spread producing step at its first field (drops the step id)", async () => {
		const wf = await workflowCallback("Spread", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const load = step("load", spreadable, {}, { spread: true });
			branch("active", load.user.active, {
				then: () => {
					step("go", noop, {});
				},
			});
		});
		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const br = steps.find((s) => s.id === "active") as { branch: { when: string } };
		// spread drops the step root: state.user.active, NOT state.load.user.active.
		expect(br.branch.when).toBe("ctx.state.user.active");
	});

	it("encodes non-identifier step ids with bracket-quote", async () => {
		const wf = await workflowCallback("Dashed", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const ok = step("is-ok", noop, {});
			branch("route", ok.flag, {
				then: () => {
					step("go", noop, {});
				},
			});
		});
		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const br = steps.find((s) => s.id === "route") as { branch: { when: string } };
		expect(br.branch.when).toBe('ctx.state["is-ok"].flag');
	});
});

// ───────────────────────── cross-arm scope guard (ADR 0003) ─────────────────

describe("branch — cross-arm handle guard (cornerstone canRead)", () => {
	it("rejects a then-handle read from the else arm", async () => {
		await expect(
			workflowCallback("CrossArm", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				let leaked: ReturnType<typeof step> | undefined;
				branch("route", makeHandle<Record<string, unknown>>("seed").flag, {
					then: () => {
						leaked = step("made-in-then", noop, {});
					},
					else: () => {
						// reading a handle minted inside `then` from `else` must throw.
						step("use-in-else", noop, { x: leaked!.value });
					},
				});
			}),
		).rejects.toThrow(/outside its scope/);
	});

	it("rejects a then-handle read AFTER the branch step", async () => {
		await expect(
			workflowCallback("AfterArm", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				let leaked: ReturnType<typeof step> | undefined;
				branch("route", makeHandle<Record<string, unknown>>("seed").flag, {
					then: () => {
						leaked = step("made-in-then", noop, {});
					},
				});
				step("after", noop, { x: leaked!.value });
			}),
		).rejects.toThrow(/outside its scope/);
	});

	it("rejects a then-handle used in a SIBLING branch condition", async () => {
		await expect(
			workflowCallback("CondLeak", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				let leaked: ReturnType<typeof step> | undefined;
				branch("first", makeHandle<Record<string, unknown>>("seed").flag, {
					then: () => {
						leaked = step("made-in-then", noop, {});
					},
				});
				branch("second", leaked!.ok, {
					then: () => {
						step("go", noop, {});
					},
				});
			}),
		).rejects.toThrow(/outside its scope/);
	});
});

// ───────────────────── (c): real Configuration + Runner ─────────────────────

/**
 * Faithful inline reconstruction of the real `@blokjs/if-else` node: it evals
 * each condition's `when` via raw `Function("ctx", ...)` (NOT through the Mapper)
 * and returns the matching arm's steps. Importing the published node here would
 * be a circular package import (it imports `@blokjs/runner`), so we mirror its
 * exact eval shape — the very behavior under test (a `js/` prefix would throw
 * "js is not defined" inside this Function call).
 */
const ifElse = defineNode({
	name: "@blokjs/if-else",
	description: "test-local mirror of the real if-else flow node",
	flow: true,
	input: z.array(z.object({ type: z.enum(["if", "else"]), condition: z.string().optional(), steps: z.array(z.any()) })),
	output: z.array(z.any()),
	execute: (ctx, conditions) => {
		for (const c of conditions) {
			if (c.condition && c.condition.trim() !== "") {
				const result = Function("ctx", `"use strict";return (${c.condition});`)(ctx);
				if (result) return c.steps as never[];
			} else {
				return c.steps as never[];
			}
		}
		return [] as never[];
	},
});

class PublishNode extends RunnerNode {
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

async function bootWorkflow(workflowDef: unknown): Promise<{ config: Configuration; ctx: Context }> {
	const config = new Configuration();
	const helpers: Record<string, RunnerNode> = {
		"@blokjs/if-else": ifElse as unknown as RunnerNode,
		"@blokjs/ctx-publish": new PublishNode(),
		noop: noop as unknown as RunnerNode,
	};
	const globalOptions = {
		nodes: { getNode: (name: string): RunnerNode | null => helpers[name] ?? null },
	} as unknown as GlobalOptions;
	await config.init("branch-e2e", globalOptions, workflowDef);
	const state: Record<string, unknown> = {};
	const ctx = {
		id: "req",
		workflow_name: "branch-e2e",
		request: { body: {}, headers: {}, params: {}, query: {} },
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
	return { config, ctx };
}

async function bootAndRun(workflowDef: unknown): Promise<Record<string, unknown>> {
	const { config, ctx } = await bootWorkflow(workflowDef);
	const runner = new Runner(config.steps as NodeBase[]);
	await runner.run(ctx);
	return ctx.state as Record<string, unknown>;
}

describe("branch — real Configuration + Runner (if-else engine)", () => {
	it("runs the THEN arm when the bare when-string is truthy (no 'js is not defined')", async () => {
		const wf = await workflowCallback("RouteTrue", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			step("seed", noop, {}); // produces state.seed; we publish a truthy flag below
			step("flag", noop, {}, { ephemeral: true });
			branch("route", makeHandle<Record<string, unknown>>("gate").open, {
				then: () => {
					step("take-then", noop, {});
				},
				else: () => {
					step("take-else", noop, {});
				},
			});
		});
		// Hand-build the def: a publish step that sets state.gate.open = true, then
		// the branch from the callback. (The callback authored the branch shape;
		// we only swap the producing steps for ctx-publish so the engine has data.)
		const branchStep = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.id === "route");
		const def = {
			name: "route-true",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{ id: "set-gate", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "gate", value: { open: true } } },
				{
					id: "route",
					branch: {
						when: (branchStep as { branch: { when: string } }).branch.when,
						then: [{ id: "mark", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "arm", value: "THEN" } }],
						else: [
							{ id: "mark-else", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "arm", value: "ELSE" } },
						],
					},
				},
			],
		};
		// Sanity: the when-string this branch authored is the bare ctx form.
		expect((branchStep as { branch: { when: string } }).branch.when).toBe("ctx.state.gate.open");

		const state = await bootAndRun(def);
		expect(state.arm).toBe("THEN");
	});

	it("runs the ELSE arm when the bare when-string is falsy", async () => {
		const def = {
			name: "route-false",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "set-gate",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "gate", value: { open: false } },
				},
				{
					id: "route",
					branch: {
						when: "ctx.state.gate.open",
						then: [{ id: "mark", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "arm", value: "THEN" } }],
						else: [
							{ id: "mark-else", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "arm", value: "ELSE" } },
						],
					},
				},
			],
		};
		const state = await bootAndRun(def);
		expect(state.arm).toBe("ELSE");
	});

	it("lets branch arms use unique ids with shared as:'run' and a downstream handle read state.run", async () => {
		const wf = await workflowCallback("SharedAs", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const run = makeHandle<{ lane: string }>("run");
			branch("route", makeHandle<{ open: boolean }>("gate").open, {
				then: () => {
					step("runA", noop, { lane: "A" }, { as: "run" });
				},
				else: () => {
					step("runB", noop, { lane: "B" }, { as: "run" });
				},
			});
			step("after", noop, { lane: run.lane });
		});

		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const branchStep = steps.find((s) => s.id === "route");
		const afterStep = steps.find((s) => s.id === "after");
		expect(afterStep?.inputs).toEqual({ lane: { $ref: { step: "run", path: ["lane"] } } });

		async function run(open: boolean): Promise<Record<string, unknown>> {
			return bootAndRun({
				name: `shared-as-${open ? "then" : "else"}`,
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{ id: "set-gate", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "gate", value: { open } } },
					branchStep,
					afterStep,
				],
			});
		}

		const thenState = await run(true);
		expect(thenState.run).toEqual({ lane: "A" });
		expect(thenState.after).toEqual({ lane: "A" });

		const elseState = await run(false);
		expect(elseState.run).toEqual({ lane: "B" });
		expect(elseState.after).toEqual({ lane: "B" });
	});

	it.each([
		{
			name: "gt",
			build: gt,
			expectedWhen: "ctx.state.left.value > ctx.state.right.value",
			truthy: [11, 10],
			falsy: [10, 10],
		},
		{
			name: "lt",
			build: lt,
			expectedWhen: "ctx.state.left.value < ctx.state.right.value",
			truthy: [9, 10],
			falsy: [10, 10],
		},
		{
			name: "eq",
			build: eq,
			expectedWhen: "ctx.state.left.value === ctx.state.right.value",
			truthy: [10, 10],
			falsy: [10, 11],
		},
		{
			name: "ne",
			build: ne,
			expectedWhen: "ctx.state.left.value !== ctx.state.right.value",
			truthy: [10, 11],
			falsy: [10, 10],
		},
		{
			name: "gte",
			build: gte,
			expectedWhen: "ctx.state.left.value >= ctx.state.right.value",
			truthy: [10, 10],
			falsy: [9, 10],
		},
		{
			name: "lte",
			build: lte,
			expectedWhen: "ctx.state.left.value <= ctx.state.right.value",
			truthy: [10, 10],
			falsy: [11, 10],
		},
	])("routes both arms for $name handle-op conditions", async ({ build, expectedWhen, truthy, falsy }) => {
		const wf = await workflowCallback("RouteOp", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const left = step("left", noop, {});
			const right = step("right", noop, {});
			branch("route", build(left.value, right.value), {
				then: () => {
					step("take-then", noop, {});
				},
				else: () => {
					step("take-else", noop, {});
				},
			});
		});
		const branchStep = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.id === "route") as {
			branch: { when: string };
		};
		expect(branchStep.branch.when).toBe(expectedWhen);
		expect(branchStep.branch.when).not.toMatch(/^js\//);

		for (const [leftValue, rightValue, expectedArm] of [
			[truthy[0], truthy[1], "THEN"],
			[falsy[0], falsy[1], "ELSE"],
		] as const) {
			const state = await bootAndRun({
				name: "route-op",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "set-left",
						use: "@blokjs/ctx-publish",
						type: "module",
						inputs: { name: "left", value: { value: leftValue } },
					},
					{
						id: "set-right",
						use: "@blokjs/ctx-publish",
						type: "module",
						inputs: { name: "right", value: { value: rightValue } },
					},
					{
						id: "route",
						branch: {
							when: branchStep.branch.when,
							then: [
								{ id: "mark-then", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "arm", value: "THEN" } },
							],
							else: [
								{ id: "mark-else", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "arm", value: "ELSE" } },
							],
						},
					},
				],
			});
			expect(state.arm).toBe(expectedArm);
		}
	});

	it("surfaces a js/-prefixed branch condition as the raw-eval footgun", async () => {
		const previousMode = process.env.BLOK_MAPPER_MODE;
		process.env.BLOK_MAPPER_MODE = "warn";
		try {
			const { config, ctx } = await bootWorkflow({
				name: "route-js-footgun",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "route",
						branch: {
							when: "js/ctx.state.missing.open",
							then: [
								{ id: "mark", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "arm", value: "THEN" } },
							],
							else: [
								{ id: "mark-else", use: "@blokjs/ctx-publish", type: "module", inputs: { name: "arm", value: "ELSE" } },
							],
						},
					},
				],
			});

			const nodeResult = await ifElse.handle(ctx, [{ type: "if", condition: "js/ctx.state.missing.open", steps: [] }]);
			expect(String((nodeResult as { error?: { message?: string } }).error?.message ?? nodeResult)).toMatch(
				/js is not defined/,
			);

			await expect(new Runner(config.steps as NodeBase[]).run(ctx)).rejects.toThrow();
			expect((ctx.state as Record<string, unknown>).arm).toBeUndefined();
		} finally {
			if (previousMode === undefined) {
				Reflect.deleteProperty(process.env, "BLOK_MAPPER_MODE");
			} else {
				process.env.BLOK_MAPPER_MODE = previousMode;
			}
		}
	});
});
