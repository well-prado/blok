/**
 * End-to-end proof for the handle-DSL cornerstone (#421):
 *
 *   author via callback workflow() + step() handles
 *     → IR carries structural { $ref }
 *     → lowerRefs (the REAL load-boundary pass) compiles them to "js/ctx.state..."
 *     → the REAL Mapper resolves those strings against a live ctx
 *     → the chained value comes out correct.
 *
 * Plus the two builder-stack guards: step() outside a callback throws, and a
 * duplicate id throws.
 *
 * The e2e deliberately exercises @blokjs/shared's real `lowerRefs` + `mapper`
 * rather than the simplified WorkflowTestRunner (which bypasses both the
 * normalizer and the Mapper) — that is the authentic wire path the runner uses.
 */

import { type Context, lowerRefs, mapper } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../src/defineNode";
import { type TriggerHandle, step, workflowCallback } from "../../src/stepBuilder";

const greet = defineNode({
	name: "greet",
	description: "wrap a name in a greeting",
	input: z.object({ name: z.string() }),
	output: z.object({ greeting: z.string() }),
	execute: (_ctx, input) => ({ greeting: `Hello, ${input.name}!` }),
});

const shout = defineNode({
	name: "shout",
	description: "uppercase a message",
	input: z.object({ message: z.string() }),
	output: z.object({ loud: z.string() }),
	execute: (_ctx, input) => ({ loud: input.message.toUpperCase() }),
});

describe("handle-DSL e2e: callback workflow() + step() → {$ref} → lowerRefs → Mapper", () => {
	it("emits structural {$ref} in step inputs and resolves the chain end-to-end", async () => {
		const wf = await workflowCallback(
			"Greet Loudly",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const greeting = step("greet", greet, { name: req.body.name });
				const loud = step("shout", shout, { message: greeting.greeting });
				step("respond", greet, { name: loud.loud });
			},
		);

		const steps = wf._config.steps as Array<{ id: string; use: string; inputs: Record<string, unknown> }>;
		expect(steps.map((s) => s.id)).toEqual(["greet", "shout", "respond"]);

		// (a) the emitted IR carries structural {$ref} — NOT yet "js/..." strings.
		expect(steps[0].inputs.name).toEqual({ $ref: { step: "@trigger", path: ["body", "name"] } });
		expect(steps[1].inputs.message).toEqual({ $ref: { step: "greet", path: ["greeting"] } });
		expect(steps[2].inputs.name).toEqual({ $ref: { step: "shout", path: ["loud"] } });

		// (b) the REAL lowerRefs compiles {$ref} into the wire strings the engine resolves.
		expect(lowerRefs(steps[0].inputs)).toEqual({ name: 'js/ctx.state["@trigger"].body.name' });
		expect(lowerRefs(steps[1].inputs)).toEqual({ message: "js/ctx.state.greet.greeting" });
		expect(lowerRefs(steps[2].inputs)).toEqual({ name: "js/ctx.state.shout.loud" });

		// (c) the REAL Mapper resolves those strings against a live ctx and the
		//     REAL nodes execute — exactly like NodeBase.process + PersistenceHelper
		//     do. Walk the chain: lower → resolve → execute → persist to ctx.state.
		const ctx = {
			state: { "@trigger": { body: { name: "ada" } } } as Record<string, unknown>,
			request: { body: { name: "ada" } },
		} as unknown as Context;
		const data = ctx.request.body as Record<string, unknown>;
		const nodes = [greet, shout, greet];

		for (let i = 0; i < steps.length; i++) {
			const inputs = lowerRefs(steps[i].inputs) as Record<string, unknown>;
			mapper.replaceObjectStrings(inputs, ctx, data);
			const res = (await nodes[i].handle(ctx, inputs)) as { success: boolean; data: Record<string, unknown> };
			expect(res.success).toBe(true);
			(ctx.state as Record<string, unknown>)[steps[i].id] = res.data;
		}

		// Chained result: trigger.name "ada" → greet → shout → greet again.
		expect((ctx.state as Record<string, unknown>).greet).toEqual({ greeting: "Hello, ada!" });
		expect((ctx.state as Record<string, unknown>).shout).toEqual({ loud: "HELLO, ADA!" });
		expect((ctx.state as Record<string, unknown>).respond).toEqual({ greeting: "Hello, HELLO, ADA!!" });
	});

	it("step() outside a workflow callback throws", () => {
		expect(() => step("orphan", greet, { name: "x" })).toThrow(/must be called inside workflow/);
	});

	it("duplicate step id within a workflow throws", async () => {
		await expect(
			workflowCallback("Dup", { version: "1.0.0", trigger: { http: { method: "GET" } } }, () => {
				step("a", greet, { name: "x" });
				step("a", shout, { message: "y" });
			}),
		).rejects.toThrow(/Duplicate step id "a"/);
	});

	it("survives await inside the callback (AsyncLocalStorage builder context)", async () => {
		const wf = await workflowCallback(
			"Async Body",
			{ version: "1.0.0", trigger: { http: { method: "GET" } } },
			async (req: TriggerHandle) => {
				const a = step("a", greet, { name: req.body.name });
				await Promise.resolve();
				step("b", shout, { message: a.greeting });
			},
		);
		const steps = wf._config.steps as Array<{ id: string; inputs: Record<string, unknown> }>;
		expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
		expect(steps[1].inputs.message).toEqual({ $ref: { step: "a", path: ["greeting"] } });
	});
});
