/**
 * v0.5 switch end-to-end integration tests.
 *
 * Boots Configuration with a workflow definition + node registry,
 * runs it through Runner, and asserts on ctx.state. Covers:
 *
 *   - literal `when` matches first-match-wins
 *   - array `when` matches any-of (group related cases)
 *   - default block runs when no case matches
 *   - no match + no default = no-op success
 *   - matched case mutations carry forward to subsequent top-level steps
 */

import type { Context, NodeBase, ResponseContext } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import Configuration from "../../src/Configuration";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import type GlobalOptions from "../../src/types/GlobalOptions";

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

async function bootConfig(workflowDef: unknown): Promise<{ config: Configuration; ctx: Context }> {
	const config = new Configuration();
	const helpers: Record<string, RunnerNode> = {
		"@blokjs/expr": new ExprNode(),
		"@blokjs/ctx-publish": new CtxPublishNode(),
	};
	const globalOptions = {
		nodes: {
			getNode: (name: string): RunnerNode | null => helpers[name] ?? null,
		},
	} as unknown as GlobalOptions;
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

describe("v0.5 switch integration", () => {
	it("literal `when` first-match-wins", async () => {
		const wfDef = {
			name: "test-switch-literal",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "init",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "kind", value: "physical" },
				},
				{
					id: "route",
					switch: {
						on: "js/ctx.state.kind",
						cases: [
							{
								when: "physical",
								do: [
									{
										id: "publish-physical",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "branch", value: "PHYSICAL" },
									},
								],
							},
							{
								when: "digital",
								do: [
									{
										id: "publish-digital",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "branch", value: "DIGITAL" },
									},
								],
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
		expect(state.branch).toBe("PHYSICAL");
	});

	it("mapper-resolves `case.when` values in raw workflow JSON", async () => {
		const wfDef = {
			name: "test-switch-dynamic-when",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "init-kind",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "kind", value: "dynamic" },
				},
				{
					id: "init-expected",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "expected", value: "dynamic" },
				},
				{
					id: "route",
					switch: {
						on: "js/ctx.state.kind",
						cases: [
							{
								when: "js/ctx.state.expected",
								do: [
									{
										id: "publish-dynamic",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "branch", value: "DYNAMIC" },
									},
								],
							},
						],
						default: [
							{
								id: "publish-default",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "branch", value: "DEFAULT" },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		await new Runner(config.steps as NodeBase[]).run(ctx);

		expect((ctx.state as Record<string, unknown>).branch).toBe("DYNAMIC");
	});

	it("array `when` matches any-of", async () => {
		const wfDef = {
			name: "test-switch-array",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "init",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "event", value: "pull_request_review" },
				},
				{
					id: "route",
					switch: {
						on: "js/ctx.state.event",
						cases: [
							{
								when: "push",
								do: [
									{
										id: "pPush",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "handler", value: "PUSH" },
									},
								],
							},
							{
								when: ["pull_request", "pull_request_review", "pull_request_review_comment"],
								do: [
									{
										id: "pPr",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "handler", value: "PR_FAMILY" },
									},
								],
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		expect((ctx.state as Record<string, unknown>).handler).toBe("PR_FAMILY");
	});

	it("default block runs when no case matches", async () => {
		const wfDef = {
			name: "test-switch-default",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "init",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "kind", value: "unknown" },
				},
				{
					id: "route",
					switch: {
						on: "js/ctx.state.kind",
						cases: [
							{
								when: "a",
								do: [
									{
										id: "p1",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "branch", value: "A" },
									},
								],
							},
						],
						default: [
							{
								id: "p-default",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "branch", value: "DEFAULT" },
							},
						],
					},
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		expect((ctx.state as Record<string, unknown>).branch).toBe("DEFAULT");
	});

	it("no match + no default = no-op success", async () => {
		const wfDef = {
			name: "test-switch-noop",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "init",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "kind", value: "nope" },
				},
				{
					id: "route",
					switch: {
						on: "js/ctx.state.kind",
						cases: [
							{
								when: "a",
								do: [
									{
										id: "p1",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "branch", value: "A" },
									},
								],
							},
						],
					},
				},
				{
					id: "marker",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "marker", value: "after-switch" },
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		const state = ctx.state as Record<string, unknown>;
		// Branch-published key absent (no match path ran)
		expect(state.branch).toBeUndefined();
		// Subsequent steps still run after the no-op switch
		expect(state.marker).toBe("after-switch");
		// Switch step's own state slot is null (the documented no-op output)
		expect(state.route).toBeNull();
	});

	it("matched case state mutations carry forward to subsequent top-level steps", async () => {
		const wfDef = {
			name: "test-switch-passthrough",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "init",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "kind", value: "x" },
				},
				{
					id: "route",
					switch: {
						on: "js/ctx.state.kind",
						cases: [
							{
								when: "x",
								do: [
									{
										id: "set-inner",
										use: "@blokjs/ctx-publish",
										type: "module",
										inputs: { name: "innerSet", value: "from-case-x" },
									},
								],
							},
						],
					},
				},
				{
					id: "echo",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "echo", value: "js/ctx.state.innerSet" },
				},
			],
		};
		const { config, ctx } = await bootConfig(wfDef);
		const runner = new Runner(config.steps as NodeBase[]);
		await runner.run(ctx);

		const state = ctx.state as Record<string, unknown>;
		expect(state.innerSet).toBe("from-case-x");
		expect(state.echo).toBe("from-case-x");
	});
});
