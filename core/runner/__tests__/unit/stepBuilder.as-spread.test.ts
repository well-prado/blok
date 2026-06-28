/**
 * #327 (as) + #342 (spread): a step handle roots at its ACTUAL persisted state
 * key, honoring the persistence knobs — the gap the cornerstone deferred.
 *
 * Drives the AUTHENTIC wire path (REAL lowerRefs + REAL Mapper + REAL
 * applyStepOutput) against a ctx built like TriggerBase.createContext, exactly as
 * stepBuilder.test.ts does:
 *
 *   - (a) as:"user"   → handle.name lowers to js/ctx.state.user.name → resolves.
 *   - (b) spread:true → handle.user → js/ctx.state.user (TOP-LEVEL, not <id>.user);
 *                       handle.profile → js/ctx.state.profile → both resolve.
 *   - (c) plain step (no knob) still roots at id — no regression.
 */

import { type Context, lowerRefs, mapper } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../src/defineNode";
import { type TriggerHandle, step, workflowCallback } from "../../src/stepBuilder";
import { applyStepOutput } from "../../src/workflow/PersistenceHelper";

function createTriggerCtx(body: Record<string, unknown>): Context {
	return {
		state: {} as Record<string, unknown>,
		request: { body, headers: {}, query: {}, params: {} },
		response: { data: null, error: null, success: true },
		workflow_name: "as-spread-e2e",
		config: {},
		func: {},
		vars: {},
	} as unknown as Context;
}

/** Run one collected step like the runner: lower → Mapper → node.handle → applyStepOutput. */
async function runStep(
	ctx: Context,
	rec: { id: string; inputs?: Record<string, unknown>; ephemeral?: boolean; spread?: boolean; as?: string },
	node: { handle: (ctx: Context, input: Record<string, unknown>) => Promise<unknown> },
): Promise<void> {
	const inputs = lowerRefs(rec.inputs ?? {}) as Record<string, unknown>;
	mapper.replaceObjectStrings(inputs, ctx, ctx.request.body as never);
	const res = (await node.handle(ctx, inputs)) as { success: boolean; data: Record<string, unknown> };
	expect(res.success).toBe(true);
	// Rule 2 (spread) / Rule 3 (as ?? name) live in the REAL persistence pass.
	applyStepOutput(ctx, { name: rec.id, ephemeral: rec.ephemeral, spread: rec.spread, as: rec.as }, res);
}

const loadUser = defineNode({
	name: "load-user",
	description: "load a user record",
	input: z.object({ id: z.string() }),
	output: z.object({ name: z.string(), id: z.string() }),
	execute: (_ctx, input) => ({ name: `user-${input.id}`, id: input.id }),
});

// Returns TWO top-level keys — the spread shape.
const loadBundle = defineNode({
	name: "load-bundle",
	description: "load user + profile",
	input: z.object({ id: z.string() }),
	output: z.object({
		user: z.object({ name: z.string() }),
		profile: z.object({ tier: z.string() }),
	}),
	execute: (_ctx, input) => ({ user: { name: `u-${input.id}` }, profile: { tier: "gold" } }),
});

const echo = defineNode({
	name: "echo",
	description: "echo back",
	input: z.object({ value: z.unknown() }),
	output: z.object({ value: z.unknown() }),
	execute: (_ctx, input) => ({ value: input.value }),
});

describe("#327 as: handle roots at the renamed state key", () => {
	it("(a) step(..., { as: 'user' }) → handle.name lowers to js/ctx.state.user.name and resolves", async () => {
		const wf = await workflowCallback(
			"As Reroot",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const u = step("load", loadUser, { id: req.body.id }, { as: "user" });
				step("greet", echo, { value: u.name });
			},
		);
		const steps = wf._config.steps as Array<{ id: string; as?: string; inputs: Record<string, unknown> }>;

		// IR: the {$ref} roots at the `as` key, NOT the step id "load".
		expect(steps[1].inputs.value).toEqual({ $ref: { step: "user", path: ["name"] } });
		// lowerRefs → ctx.state.user.name (the persisted slot), not ctx.state.load.name.
		expect(lowerRefs(steps[1].inputs)).toEqual({ value: "js/ctx.state.user.name" });

		// Real wire path: the value only resolves because the handle rooted at `as`.
		const ctx = createTriggerCtx({ id: "42" });
		await runStep(ctx, steps[0], loadUser);
		await runStep(ctx, steps[1], echo);
		const state = ctx.state as Record<string, unknown>;
		expect(state.user).toEqual({ name: "user-42", id: "42" });
		expect(state.load).toBeUndefined(); // id is NOT a state slot under `as`.
		expect(state.greet).toEqual({ value: "user-42" });
	});

	it("two arms writing the same `as` key both resolve to state.<as> (duplicate-id footgun fix)", async () => {
		const wf = await workflowCallback(
			"As Shared Key",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				// Distinct ids, shared `as` — the documented pattern for branch arms.
				const a = step("runA", loadUser, { id: req.body.id }, { as: "run" });
				step("useA", echo, { value: a.name });
			},
		);
		const steps = wf._config.steps as Array<{ inputs: Record<string, unknown> }>;
		expect(lowerRefs(steps[1].inputs)).toEqual({ value: "js/ctx.state.run.name" });
	});
});

describe("#342 spread: per-key sub-handles root at the TOP-LEVEL state key", () => {
	it("(b) step(..., { spread: true }) → handle.user / handle.profile lower to top-level state keys and resolve", async () => {
		const wf = await workflowCallback(
			"Spread Reroot",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const b = step("load", loadBundle, { id: req.body.id }, { spread: true });
				step("useUser", echo, { value: b.user.name });
				step("useProfile", echo, { value: b.profile.tier });
			},
		);
		const steps = wf._config.steps as Array<{ id: string; spread?: boolean; inputs: Record<string, unknown> }>;

		// IR: each sub-handle roots at the TOP-LEVEL key, NOT the step id "load".
		expect(steps[1].inputs.value).toEqual({ $ref: { step: "user", path: ["name"] } });
		expect(steps[2].inputs.value).toEqual({ $ref: { step: "profile", path: ["tier"] } });
		// lowerRefs → ctx.state.user / ctx.state.profile (Rule 2 top-level merge).
		expect(lowerRefs(steps[1].inputs)).toEqual({ value: "js/ctx.state.user.name" });
		expect(lowerRefs(steps[2].inputs)).toEqual({ value: "js/ctx.state.profile.tier" });

		// Real wire path: spread merges keys to top level (Rule 2) — sub-handles resolve.
		const ctx = createTriggerCtx({ id: "7" });
		await runStep(ctx, steps[0], loadBundle);
		await runStep(ctx, steps[1], echo);
		await runStep(ctx, steps[2], echo);
		const state = ctx.state as Record<string, unknown>;
		expect(state.user).toEqual({ name: "u-7" });
		expect(state.profile).toEqual({ tier: "gold" });
		expect(state.load).toBeUndefined(); // spread removes the step root.
		expect(state.useUser).toEqual({ value: "u-7" });
		expect(state.useProfile).toEqual({ value: "gold" });
	});

	it("reading a spread handle AS A WHOLE (whole-output ref) throws — only per-key reads are valid", async () => {
		await expect(
			workflowCallback(
				"Spread Whole",
				{ version: "1.0.0", trigger: { http: { method: "POST" } } },
				(req: TriggerHandle) => {
					const b = step("load", loadBundle, { id: req.body.id }, { spread: true });
					// Passing the whole spread handle as an input ref — invalid (#342).
					step("bad", echo, { value: b as unknown as string });
				},
			),
		).rejects.toThrow(/spread: true.*top level|has no whole-output slot/i);
	});

	it("spread on a non-object output (z.record) throws at authoring time with an actionable message", async () => {
		const recordNode = defineNode({
			name: "record-node",
			description: "dynamic keys",
			input: z.object({}),
			output: z.record(z.string()),
			execute: () => ({ a: "1" }),
		});
		await expect(
			workflowCallback("Spread Record", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				step("load", recordNode, {}, { spread: true });
			}),
		).rejects.toThrow(/statically-known object/i);
	});

	it("spread + as together throw (mutually exclusive)", async () => {
		await expect(
			workflowCallback("Spread As", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				step("load", loadBundle, { id: "x" }, { spread: true, as: "nope" });
			}),
		).rejects.toThrow(/mutually exclusive/i);
	});
});

describe("(c) no-knob regression: a plain step still roots at id", () => {
	it("handle.name lowers to js/ctx.state.<id>.name and resolves", async () => {
		const wf = await workflowCallback(
			"Plain Root",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const u = step("load", loadUser, { id: req.body.id });
				step("greet", echo, { value: u.name });
			},
		);
		const steps = wf._config.steps as Array<{ inputs: Record<string, unknown> }>;
		expect(steps[1].inputs.value).toEqual({ $ref: { step: "load", path: ["name"] } });
		expect(lowerRefs(steps[1].inputs)).toEqual({ value: "js/ctx.state.load.name" });

		const ctx = createTriggerCtx({ id: "9" });
		await runStep(ctx, steps[0], loadUser);
		await runStep(ctx, steps[1], echo);
		const state = ctx.state as Record<string, unknown>;
		expect(state.load).toEqual({ name: "user-9", id: "9" });
		expect(state.greet).toEqual({ value: "user-9" });
	});
});
