/**
 * v0.5 tryCatch end-to-end integration tests.
 *
 * Boots Configuration with a workflow definition + node registry,
 * runs it through Runner, and asserts on ctx.state. Covers:
 *
 *   - try succeeds → catch is skipped, finally runs
 *   - try throws → catch runs with $.error populated
 *   - try throws + catch throws → outer error after finally
 *   - finally always runs (success path AND error path)
 *   - state mutations from any block are visible to subsequent steps
 */

import type { Context, NodeBase, ResponseContext } from "@blokjs/shared";
import { GlobalError } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Configuration from "../../src/Configuration";
import { RunCancelledError } from "../../src/RunCancelledError";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { WaitDispatchRequest } from "../../src/WaitDispatchRequest";
import { defineNode } from "../../src/defineNode";

class ExprNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/expr";
		this.node = "@blokjs/expr";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as {
			inputs?: { expression?: string };
		};
		const expr = opts.inputs?.expression ?? "undefined";
		const data = (ctx.response?.data ?? ctx.request?.body ?? {}) as Record<string, unknown>;
		const vars = (ctx.vars ?? {}) as Record<string, unknown>;
		const fn = new Function("ctx", "data", "vars", `"use strict";return (${expr});`);
		return { success: true, data: fn(ctx, data, vars), error: null };
	}
}

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
		const value = opts.inputs?.value;
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		state[name] = value;
		return { success: true, data: { name, value }, error: null };
	}
}

class ThrowNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/throw";
		this.node = "@blokjs/throw";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as {
			inputs?: { message?: string };
		};
		const msg = opts.inputs?.message ?? "test failure";
		throw new Error(msg);
	}
}

/**
 * Test-only node that throws WaitDispatchRequest. Lets us verify that
 * TryCatchNode correctly passes the wait signal through its catch arm
 * (Phase 1 of wait-inside-primitives) without the cost of materializing
 * a real wait step + dispatch + re-entry round trip.
 */
class ThrowWaitNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/test-throw-wait";
		this.node = "@blokjs/test-throw-wait";
		this.type = "module";
		this.active = true;
	}
	async run(_ctx: Context): Promise<ResponseContext> {
		throw new WaitDispatchRequest({
			scheduledAt: Date.now() + 1000,
			stepIndex: 0,
			stepId: "test-wait",
			lastCompletedStepIndex: -1,
		});
	}
}

/**
 * Test-only node that throws RunCancelledError. Same rationale as
 * ThrowWaitNode — verify pass-through without an actual cancel
 * AbortController round trip.
 */
class ThrowCancelNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/test-throw-cancel";
		this.node = "@blokjs/test-throw-cancel";
		this.type = "module";
		this.active = true;
	}
	async run(_ctx: Context): Promise<ResponseContext> {
		throw new RunCancelledError("test-run-id");
	}
}

/**
 * Build a defineNode-built test step that throws on execute. This goes
 * through the SAME error-handling pipeline as a real production node
 * (defineNode.handle catches → returns BlokResponse with .error set →
 * Blok.run flips response.success → applyStepOutput's error guard skips
 * state writes). Use this — not the raw `ThrowNode` above — when a test
 * needs to validate the post-error state contract.
 */
function makeFailingDefineNode(name: string, opts: { code?: number } = {}): RunnerNode {
	const node = defineNode({
		name,
		input: z.unknown(),
		output: z.unknown(),
		async execute(_ctx, _input) {
			if (opts.code !== undefined) {
				const err = new GlobalError(`${name} failed with code ${opts.code}`);
				err.setCode(opts.code);
				err.setName(`${name}Error`);
				// Mirror @blokjs/throw — set the literal Error.name so the
				// `toErrorEnvelope` walk surfaces it as `$.error.name`.
				// GlobalError.setName only writes to its internal `context.name`.
				(err as Error).name = `${name}Error`;
				throw err;
			}
			throw new Error(`${name} failed`);
		},
	}) as unknown as RunnerNode;
	(node as unknown as { name: string }).name = name;
	(node as unknown as { node: string }).node = name;
	(node as unknown as { type: string }).type = "module";
	(node as unknown as { active: boolean }).active = true;
	return node;
}

/**
 * Build a defineNode-built test step that succeeds, capturing whatever
 * the inputs evaluate to into ctx.state[<name>]. Pairs with
 * `makeFailingDefineNode` for end-to-end error-path tests.
 */
function makeSucceedingDefineNode(name: string): RunnerNode {
	const node = defineNode({
		name,
		input: z.unknown(),
		output: z.unknown(),
		async execute(_ctx, input) {
			return { received: input };
		},
	}) as unknown as RunnerNode;
	(node as unknown as { name: string }).name = name;
	(node as unknown as { node: string }).node = name;
	(node as unknown as { type: string }).type = "module";
	(node as unknown as { active: boolean }).active = true;
	return node;
}

async function bootConfig(
	workflowDef: unknown,
	extraNodes: Record<string, RunnerNode> = {},
): Promise<{ config: Configuration; ctx: Context }> {
	const config = new Configuration();
	const helpers: Record<string, RunnerNode> = {
		"@blokjs/expr": new ExprNode(),
		"@blokjs/ctx-publish": new CtxPublishNode(),
		"@blokjs/throw": new ThrowNode(),
		"@blokjs/test-throw-wait": new ThrowWaitNode(),
		"@blokjs/test-throw-cancel": new ThrowCancelNode(),
		...extraNodes,
	};
	const globalOptions = {
		nodes: {
			getNode: (name: string): RunnerNode | null => helpers[name] ?? null,
		},
	};
	await config.init("test-wf", globalOptions, workflowDef);
	const state: Record<string, unknown> = {};
	const ctx = {
		id: "test-req",
		workflow_name: "test-wf",
		workflow_path: "/test",
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

describe("v0.5 tryCatch integration", () => {
	it("try succeeds → catch is skipped, finally runs", async () => {
		const wfDef = {
			name: "test-trycatch-success",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [
							{
								id: "ok",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "trySet", value: "ran" },
							},
						],
						catch: [
							{
								id: "should-not-run",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "catchSet", value: "should-not-be-here" },
							},
						],
						finally: [
							{
								id: "metric",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "finallySet", value: "always" },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		const state = ctx.state as Record<string, unknown>;
		expect(state.trySet).toBe("ran");
		expect(state.catchSet).toBeUndefined();
		expect(state.finallySet).toBe("always");
	});

	it("try throws → catch runs with $.error populated, finally still runs", async () => {
		const wfDef = {
			name: "test-trycatch-throw",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [
							{
								id: "early",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "earlySet", value: "yes" },
							},
							{
								id: "boom",
								use: "@blokjs/throw",
								type: "module",
								inputs: { message: "kaboom" },
							},
							{
								id: "never",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "neverSet", value: "should-not-be-here" },
							},
						],
						catch: [
							{
								id: "capture",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "caught", value: "js/ctx.error.message" },
							},
						],
						finally: [
							{
								id: "metric",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "metricsRan", value: true },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		const state = ctx.state as Record<string, unknown>;
		expect(state.earlySet).toBe("yes");
		expect(state.neverSet).toBeUndefined();
		expect(state.caught).toBe("kaboom");
		expect(state.metricsRan).toBe(true);
	});

	it("ctx.error is cleared after tryCatch — subsequent top-level steps don't see $.error", async () => {
		const wfDef = {
			name: "test-trycatch-clear",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [
							{
								id: "boom",
								use: "@blokjs/throw",
								type: "module",
								inputs: { message: "oops" },
							},
						],
						catch: [
							{
								id: "noop",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "swallowed", value: true },
							},
						],
					},
				},
				{
					id: "after",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "errorAfter", value: "js/ctx.error" },
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		const state = ctx.state as Record<string, unknown>;
		expect(state.swallowed).toBe(true);
		// ctx.error after the tryCatch is whatever it was BEFORE — the
		// initial test rig sets ctx.error = { message: [] }, so the
		// `js/ctx.error` resolution returns that object.
		expect(state.errorAfter).toEqual({ message: [] });
	});

	it("finally throws → its error propagates and overrides catch's pending throw", async () => {
		const wfDef = {
			name: "test-trycatch-finally-throws",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [
							{
								id: "ok",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "trySet", value: "ran" },
							},
						],
						catch: [
							{
								id: "noop",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "catchSet", value: "should-not-fire" },
							},
						],
						finally: [
							{
								id: "boom",
								use: "@blokjs/throw",
								type: "module",
								inputs: { message: "finally exploded" },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		let caught: unknown = null;
		try {
			await runner.run(ctx);
		} catch (err) {
			caught = err;
		}
		const errMsg = caught instanceof Error ? caught.message : String(caught);
		expect(errMsg).toMatch(/finally exploded/);
	});

	it("catch throws → that error propagates after finally completes", async () => {
		const wfDef = {
			name: "test-trycatch-catch-throws",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [
							{
								id: "boom1",
								use: "@blokjs/throw",
								type: "module",
								inputs: { message: "from-try" },
							},
						],
						catch: [
							{
								id: "boom2",
								use: "@blokjs/throw",
								type: "module",
								inputs: { message: "from-catch" },
							},
						],
						finally: [
							{
								id: "metric",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "finallySet", value: true },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		let caught: unknown = null;
		try {
			await runner.run(ctx);
		} catch (err) {
			caught = err;
		}
		// catch's error wins (catch threw last), but finally still ran.
		const errMsg = caught instanceof Error ? caught.message : String(caught);
		expect(errMsg).toMatch(/from-catch/);
		expect((ctx.state as Record<string, unknown>).finallySet).toBe(true);
	});
});

/**
 * Error-path state contract — the v0.5.1 fix surface.
 *
 * Before the fix, a defineNode-built step that threw still wrote
 * `ctx.state[<step.id>] = {}` because Blok.run unconditionally called
 * `applyStepOutput` and `BlokResponse.setError()` set `data = {}`. That
 * empty-but-defined object made the natural saga rollback check
 * (`ctx.state['create-account'] !== undefined`) silently lie — it
 * always returned true after an attempt, regardless of whether the
 * attempt succeeded.
 *
 * The centralized fix in PersistenceHelper.applyStepOutput skips
 * persistence when the result envelope carries any error indicator
 * (`success: false`, non-null `error`, or non-null `errors`). These
 * tests pin that contract so it can't regress.
 */
describe("v0.5 tryCatch — error-path state contract (post-fix)", () => {
	it("an errored try-arm step does NOT write ctx.state[<step.id>]", async () => {
		const failingFetch = makeFailingDefineNode("fetch-user");
		const wfDef = {
			name: "test-trycatch-no-state-on-error",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [{ id: "fetch-user", use: "fetch-user", type: "module", inputs: {} }],
						catch: [
							// Read state['fetch-user'] inside catch — must be undefined
							// since the step threw. Pre-fix, this was an empty object.
							{
								id: "record",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: {
									name: "fetchUserStateAtCatch",
									value: "js/typeof ctx.state['fetch-user']",
								},
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef, { "fetch-user": failingFetch });
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		const state = ctx.state as Record<string, unknown>;
		expect(state.fetchUserStateAtCatch).toBe("undefined");
		expect(state["fetch-user"]).toBeUndefined();
	});

	it("a saga using `state['<step>'] !== undefined` correctly distinguishes did-not-run from did-run", async () => {
		// This is the exact contract the v05-user-signup-saga relies on
		// post-fix. Pre-fix this test would have failed both paths because
		// `state['create-account']` was {} after a throw, making `!==
		// undefined` always true. Post-fix, the existence check tells the
		// truth: undefined when the step never succeeded, defined when it
		// did. Captured as a string snapshot inside the catch arm so we
		// don't depend on the `branch` flow node (separate package).
		const okAccount = makeSucceedingDefineNode("create-account");
		const okProfile = makeSucceedingDefineNode("create-profile");
		const failingAccount = makeFailingDefineNode("create-account");
		const failingProfile = makeFailingDefineNode("create-profile");

		const buildWf = (variant: string) => ({
			name: `test-trycatch-existence-truth-${variant}`,
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [
							{ id: "create-account", use: "create-account", type: "module", inputs: {} },
							{ id: "create-profile", use: "create-profile", type: "module", inputs: {} },
						],
						catch: [
							{
								id: "rollback-decision",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: {
									name: "rolledBack",
									value: "js/ctx.state['create-account'] !== undefined",
								},
							},
						],
					},
				},
			],
		});

		// Path A — account-create itself fails. Pre-fix this returned true
		// (the bug). Post-fix it returns false: the step never wrote state.
		{
			const { config, ctx } = await bootConfig(buildWf("acct-fail"), {
				"create-account": failingAccount,
				"create-profile": okProfile, // unused on this path
			});
			const runner = new Runner(config.steps as NodeBase[]);
			await runner.run(ctx);
			expect((ctx.state as Record<string, unknown>).rolledBack).toBe(false);
		}

		// Path B — account-create succeeds, profile-create fails after.
		// Both pre- and post-fix this returns true, but for different
		// reasons: pre-fix because state was always {}; post-fix because
		// the step actually produced a real {received: ...} payload.
		{
			const { config, ctx } = await bootConfig(buildWf("profile-fail"), {
				"create-account": okAccount,
				"create-profile": failingProfile,
			});
			const runner = new Runner(config.steps as NodeBase[]);
			await runner.run(ctx);
			expect((ctx.state as Record<string, unknown>).rolledBack).toBe(true);
		}
	});

	it("$.error.code resolves to GlobalError.code inside the catch arm", async () => {
		const failing401 = makeFailingDefineNode("auth", { code: 401 });
		const wfDef = {
			name: "test-trycatch-error-code",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [{ id: "auth", use: "auth", type: "module", inputs: {} }],
						catch: [
							{
								id: "capture-code",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "errCode", value: "js/ctx.error.code" },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef, { auth: failing401 });
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		expect((ctx.state as Record<string, unknown>).errCode).toBe(401);
	});

	it("$.error.stepId resolves to the failing try-step's id inside the catch arm", async () => {
		const failingMid = makeFailingDefineNode("middle-step");
		const wfDef = {
			name: "test-trycatch-error-stepid",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [
							{
								id: "first-ok",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "firstRan", value: true },
							},
							{ id: "middle-step", use: "middle-step", type: "module", inputs: {} },
							{
								id: "after-never",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "afterRan", value: true },
							},
						],
						catch: [
							{
								id: "capture-stepid",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "failedAt", value: "js/ctx.error.stepId" },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef, { "middle-step": failingMid });
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		const state = ctx.state as Record<string, unknown>;
		expect(state.firstRan).toBe(true);
		expect(state.afterRan).toBeUndefined(); // throw aborted the try arm
		expect(state.failedAt).toBe("middle-step");
	});

	it("ctx.error envelope still carries message + name + stack alongside new fields", async () => {
		const failing = makeFailingDefineNode("payment", { code: 402 });
		const wfDef = {
			name: "test-trycatch-error-full-envelope",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [{ id: "payment", use: "payment", type: "module", inputs: {} }],
						catch: [
							{
								id: "snapshot",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: {
									name: "errSnap",
									value:
										"js/({message: ctx.error.message, name: ctx.error.name, code: ctx.error.code, stepId: ctx.error.stepId, hasStack: typeof ctx.error.stack === 'string'})",
								},
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef, { payment: failing });
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		const snap = (ctx.state as Record<string, unknown>).errSnap as Record<string, unknown>;
		expect(snap.message).toMatch(/payment failed with code 402/);
		expect(snap.name).toBe("paymentError");
		expect(snap.code).toBe(402);
		expect(snap.stepId).toBe("payment");
		expect(snap.hasStack).toBe(true);
	});
});

/**
 * v0.5.3 Phase 1 — wait-inside-primitives partial fix.
 *
 * `WaitDispatchRequest` (the runner's "defer this run" signal) and
 * `RunCancelledError` (cooperative cancellation signal) used to be
 * caught by `TryCatchNode`'s catch arm and fall through to
 * `toErrorEnvelope`, which silently broke both contracts: the wait
 * effectively no-op'd (the run never deferred, the catch + finally
 * arms ran, the workflow returned success); the cancel was treated as
 * an exception and the workflow continued past cancellation.
 *
 * The fix is a pair of `instanceof` re-throws in TryCatchNode.run
 * before either signal can reach `toErrorEnvelope`. Finally is also
 * skipped on this path — the wait/cancel hasn't completed, and finally
 * semantically fires on completion. On wait re-entry the entire
 * tryCatch step re-executes (Phase 1 limit: no mid-arm resume), so
 * finally fires when that re-run reaches a terminal state.
 *
 * Phase 1 author contract: every step in a `try` arm that contains a
 * wait MUST be idempotent.
 */
describe("v0.5.3 Phase 1 — wait + cancel pass-through (TryCatchNode)", () => {
	it("WaitDispatchRequest thrown inside try arm is RE-THROWN, not caught", async () => {
		// Arrange a tryCatch whose try arm throws WaitDispatchRequest.
		// Catch arm sets a state marker; if it ran we'd see the marker
		// after the run failed/threw. Pre-fix the catch arm fired and
		// finally ran; post-fix neither runs and the wait propagates.
		const wfDef = {
			name: "test-wait-passthrough-try",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [{ id: "wait-step", use: "@blokjs/test-throw-wait", type: "module", inputs: {} }],
						catch: [
							{
								id: "should-not-fire",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "catchFired", value: true },
							},
						],
						finally: [
							{
								id: "should-not-fire-finally",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "finallyFired", value: true },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		let thrown: unknown = null;
		try {
			await runner.run(ctx);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(WaitDispatchRequest);
		// Neither catch nor finally fired — the run is deferring, not
		// completing.
		const state = ctx.state as Record<string, unknown>;
		expect(state.catchFired).toBeUndefined();
		expect(state.finallyFired).toBeUndefined();
	});

	it("RunCancelledError thrown inside try arm is RE-THROWN, not caught", async () => {
		const wfDef = {
			name: "test-cancel-passthrough-try",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [{ id: "cancel-step", use: "@blokjs/test-throw-cancel", type: "module", inputs: {} }],
						catch: [
							{
								id: "should-not-fire",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "catchFired", value: true },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		let thrown: unknown = null;
		try {
			await runner.run(ctx);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(RunCancelledError);
		expect((ctx.state as Record<string, unknown>).catchFired).toBeUndefined();
	});

	it("WaitDispatchRequest thrown inside catch arm is RE-THROWN (Phase 1 best-effort)", async () => {
		// catch-arm waits aren't formally supported in Phase 1 (re-entry
		// semantics differ — the resumed run re-runs the WHOLE tryCatch
		// from the top, including try, which may not throw the same way).
		// But we still pass the signal through here so it's not silently
		// swallowed by the inner pendingError catch.
		const wfDef = {
			name: "test-wait-passthrough-catch",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [{ id: "trigger-catch", use: "@blokjs/throw", type: "module", inputs: { message: "fail" } }],
						catch: [{ id: "wait-in-catch", use: "@blokjs/test-throw-wait", type: "module", inputs: {} }],
						finally: [
							{
								id: "should-not-fire",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "finallyFired", value: true },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		let thrown: unknown = null;
		try {
			await runner.run(ctx);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(WaitDispatchRequest);
		// Finally also skipped on this path — the wait hasn't completed;
		// finally fires on the resumed run.
		expect((ctx.state as Record<string, unknown>).finallyFired).toBeUndefined();
	});

	it("regular Errors STILL flow through catch (regression — pass-through must not affect normal exception handling)", async () => {
		// Make sure the new instanceof guards don't also catch generic
		// Error subclasses by accident. A normal throw should still be
		// converted to ctx.error and trigger the catch arm.
		const wfDef = {
			name: "test-regular-error-still-caught",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "saga",
					tryCatch: {
						try: [{ id: "boom", use: "@blokjs/throw", type: "module", inputs: { message: "kaboom" } }],
						catch: [
							{
								id: "captured",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "caught", value: "js/ctx.error.message" },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);
		// Regular Error → catch ran with $.error.message = "kaboom"
		expect((ctx.state as Record<string, unknown>).caught).toBe("kaboom");
	});
});
