/**
 * #461 / ADR 0008 — the `js` escape-hatch tag. It is author-only SUGAR: it
 * lowers to a bare `js/<expr>` STRING at authoring time (NOT a new structural IR
 * member), with interpolated handles converted to their bare ctx path via the
 * canonical lowerRefs. The string then flows through lowerRefs unchanged
 * (strings pass through) and the EXISTING Mapper resolves it — no new pipeline
 * stage, no Mapper change. Proves the chosen Option-2 reconciliation end to end.
 */

import { type Context, lowerRefs, mapper } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../src/defineNode";
import { type TriggerHandle, js, step, workflowCallback } from "../../src/stepBuilder";

const passthrough = defineNode({
	name: "pt",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	async execute(_ctx, input) {
		return input;
	},
});

function ctxWith(state: Record<string, unknown>, body: Record<string, unknown> = {}): Context {
	return {
		state,
		request: { body, headers: {}, query: {}, params: {} },
		response: { data: null, error: null, success: true },
		config: {},
		func: {},
		vars: {},
	} as unknown as Context;
}

function resolveInput(inputs: Record<string, unknown>, ctx: Context): Record<string, unknown> {
	const lowered = lowerRefs(inputs) as Record<string, unknown>;
	mapper.replaceObjectStrings(lowered, ctx, ctx.request.body as never);
	return lowered;
}

describe("js tag (#461) — escape hatch lowers to a bare js/ string, resolves through the Mapper", () => {
	it("emits js/<expr> with the interpolated handle lowered to its bare ctx path", async () => {
		const wf = await workflowCallback(
			"jsdemo",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const order = step("order", passthrough, { total: req.body.total });
				step("classify", passthrough, { tier: js`${order.total} > 100 ? "big" : "small"` });
			},
		);
		const steps = wf._config.steps as Array<{ inputs: Record<string, unknown> }>;
		// authoring-time SUGAR → a bare js/ string (NOT a {$ref}/{$tpl}/{$js} object).
		expect(steps[1].inputs.tier).toBe('js/ctx.state.order.total > 100 ? "big" : "small"');
		// resolves through the existing Mapper (the whole expression, both branches).
		expect(resolveInput(steps[1].inputs, ctxWith({ order: { total: 250 } })).tier).toBe("big");
		expect(resolveInput(steps[1].inputs, ctxWith({ order: { total: 5 } })).tier).toBe("small");
	});

	it("encodes the `?? default` footgun the structural handle model cannot express", async () => {
		const wf = await workflowCallback(
			"jsdef",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const load = step("load", passthrough, { value: req.body.v });
				step("use", passthrough, { v: js`${load.value} ?? "fallback"` });
			},
		);
		const steps = wf._config.steps as Array<{ inputs: Record<string, unknown> }>;
		expect(steps[1].inputs.v).toBe('js/ctx.state.load.value ?? "fallback"');
		// present-but-null root slot → resolves to the default (NamedMissingState only fires on a MISSING root).
		expect(resolveInput(steps[1].inputs, ctxWith({ load: { value: null } })).v).toBe("fallback");
		expect(resolveInput(steps[1].inputs, ctxWith({ load: { value: "real" } })).v).toBe("real");
	});

	it("lowers a trigger handle inside the expression to ctx.request.*", async () => {
		const wf = await workflowCallback(
			"jsreq",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				step("double", passthrough, { n: js`${req.body.n} * 2` });
			},
		);
		const steps = wf._config.steps as Array<{ inputs: Record<string, unknown> }>;
		expect(steps[0].inputs.n).toBe("js/ctx.request.body.n * 2");
		expect(resolveInput(steps[0].inputs, ctxWith({}, { n: 21 })).n).toBe(42);
	});

	it("a plain (non-handle) interpolation is JSON-encoded into the expression", async () => {
		const threshold = 100;
		const wf = await workflowCallback(
			"jslit",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				step("gate", passthrough, { ok: js`${req.body.n} >= ${threshold}` });
			},
		);
		const steps = wf._config.steps as Array<{ inputs: Record<string, unknown> }>;
		expect(steps[0].inputs.ok).toBe("js/ctx.request.body.n >= 100");
		expect(resolveInput(steps[0].inputs, ctxWith({}, { n: 150 })).ok).toBe(true);
	});
});
