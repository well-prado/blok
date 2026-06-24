/**
 * Bug 3 — the REAL root cause is NOT "switch arm output doesn't propagate".
 * Switch is a passthrough and inner-step state DOES carry to siblings. The
 * report's repro (and the first cut of this test) reused the SAME inner step
 * id `run` in BOTH the case and the default arm. Inner-step inputs are
 * flattened into the workflow's FLAT config map keyed by step id
 * (WorkflowNormalizer: `Object.assign(internalNodes, innerNodes)`), so two
 * arms named `run` collide — last-wins — and the matched arm silently runs
 * with the OTHER arm's inputs.
 *
 *   - PROPAGATION (unique ids + `as` to share a state key): works, top-level
 *     and inside forEach.
 *   - COLLISION (duplicate id across arms): the matched "a" arm returns the
 *     default arm's value — the silent miscompile.
 */

import type { Context, NodeBase } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Configuration from "../../src/Configuration";
import Runner from "../../src/Runner";
import type RunnerNode from "../../src/RunnerNode";
import { defineNode } from "../../src/defineNode";
import type GlobalOptions from "../../src/types/GlobalOptions";

const ArmNode = defineNode({
	name: "arm",
	description: "test fixture — returns { v }",
	input: z.object({ v: z.number() }),
	output: z.object({ v: z.number() }),
	async execute(_ctx, input) {
		return { v: input.v };
	},
});

const SiblingNode = defineNode({
	name: "sibling",
	description: "test fixture — reads ctx.state.run",
	input: z.object({}),
	output: z.object({ got: z.unknown() }),
	async execute(ctx) {
		const run = (ctx.state as Record<string, unknown>).run as { v?: unknown } | undefined;
		return { got: run ? run.v : undefined };
	},
});

async function bootConfig(workflowDef: unknown): Promise<{ config: Configuration; ctx: Context }> {
	const config = new Configuration();
	const helpers: Record<string, RunnerNode> = {
		arm: ArmNode as unknown as RunnerNode,
		sibling: SiblingNode as unknown as RunnerNode,
	};
	const globalOptions = {
		nodes: { getNode: (name: string): RunnerNode | null => helpers[name] ?? null },
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
		logger: { log: () => {}, logLevel: () => {}, error: () => {} },
		config: config.nodes,
		vars: state,
		state,
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
	return { config, ctx };
}

/** Switch whose arms use UNIQUE inner ids but share a state key via `as: "run"`. */
function uniqueIdSwitch(id: string) {
	return {
		id,
		switch: {
			on: "js/ctx.state.item.kind",
			cases: [{ when: "a", do: [{ id: "runA", use: "arm", type: "module", as: "run", inputs: { v: 1 } }] }],
			default: [{ id: "runDefault", use: "arm", type: "module", as: "run", inputs: { v: 0 } }],
		},
	};
}
/** Switch whose arms reuse the SAME inner id `run` — the collision footgun. */
function dupIdSwitch(id: string) {
	return {
		id,
		switch: {
			on: "js/ctx.state.item.kind",
			cases: [{ when: "a", do: [{ id: "run", use: "arm", type: "module", inputs: { v: 1 } }] }],
			default: [{ id: "run", use: "arm", type: "module", inputs: { v: 0 } }],
		},
	};
}
const siblingStep = { id: "next", use: "sibling", type: "module", inputs: {} };

describe("switch arm output → sibling (Bug 3 — real cause is duplicate inner ids)", () => {
	it("PROPAGATION: top-level switch arm output reaches a sibling (unique ids + as)", async () => {
		const { config, ctx } = await bootConfig({
			name: "ctrl",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [uniqueIdSwitch("pick"), siblingStep],
		});
		(ctx.state as Record<string, unknown>).item = { kind: "a" };
		await new Runner(config.steps as NodeBase[]).run(ctx);
		expect((ctx.state as Record<string, unknown>).next).toEqual({ got: 1 });
	});

	it("PROPAGATION: forEach → switch arm output reaches a sibling per iteration (unique ids + as)", async () => {
		const { config, ctx } = await bootConfig({
			name: "foreach-ok",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "scoreItems",
					forEach: {
						in: [{ kind: "a" }, { kind: "b" }],
						as: "item",
						mode: "sequential",
						do: [uniqueIdSwitch("pick"), siblingStep],
					},
				},
			],
		});
		await new Runner(config.steps as NodeBase[]).run(ctx);
		expect((ctx.state as Record<string, unknown>).scoreItems).toEqual([{ got: 1 }, { got: 0 }]);
	});

	it("COLLISION: duplicate inner id `run` across arms is rejected at load time", async () => {
		// Previously this silently ran the matched arm with the OTHER arm's
		// inputs (a miscompile). The load-time duplicate-id guard now turns it
		// into a clear error instead.
		await expect(
			bootConfig({
				name: "collision",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [dupIdSwitch("pick"), siblingStep],
			}),
		).rejects.toThrow(/duplicate step id "run"/);
	});
});
