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
import { describe, expect, it } from "vitest";
import Configuration from "../../src/Configuration";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";

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

async function bootConfig(workflowDef: unknown): Promise<{ config: Configuration; ctx: Context }> {
	const config = new Configuration();
	const helpers: Record<string, RunnerNode> = {
		"@blokjs/expr": new ExprNode(),
		"@blokjs/ctx-publish": new CtxPublishNode(),
		"@blokjs/throw": new ThrowNode(),
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
