/**
 * #430 — every unary trigger's entry handle (`req`/`event`/`tick`/`job`/`msg`/
 * `rpc`) resolves to the SAME source the ctx carries, and lowers through the
 * IDENTICAL `{$ref}` → `lowerRefs` path a `step()` handle uses — only the root
 * differs (entry → `ctx.request`, step → `ctx.state`). This is the
 * "two-divergent-paths" risk the founder's Mapper finding flagged: if entry
 * handles lowered differently (or left a raw `{$ref}` the string-only Mapper
 * silently passes through), trigger inputs would resolve to undefined.
 *
 * Pure authoring + lowering + Mapper-resolution (no per-trigger network
 * runtime) — every request-shaped trigger funnels its payload into
 * `ctx.request.{body,params,query,headers}`, so a trigger-shaped ctx is all the
 * resolution leg needs.
 */

import { type Context, lowerRefs, mapper } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../src/defineNode";
import { type TriggerHandle, step, workflowCallback } from "../../src/stepBuilder";

const passthrough = defineNode({
	name: "passthrough",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	async execute(_ctx, input) {
		return input;
	},
});

/** A ctx shaped like TriggerBase.createContext: payload at ctx.request, state empty. */
function triggerCtx(req: {
	body?: Record<string, unknown>;
	params?: Record<string, string>;
	query?: Record<string, string>;
}): Context {
	return {
		state: {} as Record<string, unknown>,
		request: { body: req.body ?? {}, headers: {}, query: req.query ?? {}, params: req.params ?? {} },
		response: { data: null, error: null, success: true },
		workflow_name: "entry-handles",
		config: {},
		func: {},
		vars: {},
	} as unknown as Context;
}

/** Lower a step's {$ref} inputs and resolve them through the REAL Mapper. */
function resolve(inputs: Record<string, unknown>, ctx: Context): Record<string, unknown> {
	const lowered = lowerRefs(inputs) as Record<string, unknown>;
	mapper.replaceObjectStrings(lowered, ctx, ctx.request.body as never);
	return lowered;
}

// One representative field read per unary trigger + where it lands in ctx.request.
const CASES = [
	{
		kind: "http (req)",
		trigger: { http: { method: "POST" } },
		read: (e: TriggerHandle) => e.body.name,
		path: ["body", "name"],
		lowered: "js/ctx.request.body.name",
		ctx: { body: { name: "ada" } },
		value: "ada",
	},
	{
		kind: "webhook (event)",
		trigger: { webhook: { provider: "github" } },
		read: (e: TriggerHandle) => e.body.id,
		path: ["body", "id"],
		lowered: "js/ctx.request.body.id",
		ctx: { body: { id: "evt_1" } },
		value: "evt_1",
	},
	{
		kind: "cron (tick) — no body, params only",
		trigger: { cron: { schedule: "0 * * * *" } },
		read: (e: TriggerHandle) => e.params.schedule,
		path: ["params", "schedule"],
		lowered: "js/ctx.request.params.schedule",
		ctx: { params: { schedule: "0 * * * *" } },
		value: "0 * * * *",
	},
	{
		kind: "worker (job) — 0-based attempt in params",
		trigger: { worker: { queue: "jobs" } },
		read: (e: TriggerHandle) => e.params.attempt,
		path: ["params", "attempt"],
		lowered: "js/ctx.request.params.attempt",
		ctx: { params: { attempt: "0" } },
		value: "0",
	},
	{
		kind: "pubsub (msg)",
		trigger: { pubsub: { topic: "orders.created" } },
		read: (e: TriggerHandle) => e.body.payload,
		path: ["body", "payload"],
		lowered: "js/ctx.request.body.payload",
		ctx: { body: { payload: 42 } },
		value: 42,
	},
	{
		kind: "grpc (rpc) — no schema, unknown payload",
		trigger: { grpc: {} },
		read: (e: TriggerHandle) => e.body.field,
		path: ["body", "field"],
		lowered: "js/ctx.request.body.field",
		ctx: { body: { field: "x" } },
		value: "x",
	},
	{
		// #431 — sse `conn` is a READ-ONLY ctx.request-rooted entry handle (no body;
		// real-time emit stays in the helper nodes).
		kind: "sse (conn) — read-only params/query/headers",
		trigger: { sse: {} },
		read: (e: TriggerHandle) => e.params.roomId,
		path: ["params", "roomId"],
		lowered: "js/ctx.request.params.roomId",
		ctx: { params: { roomId: "general" } },
		value: "general",
	},
	{
		// #431 — websocket `conn.body` is the parsed message; lowers like the rest.
		kind: "websocket (conn) — message body + params",
		trigger: { websocket: {} },
		read: (e: TriggerHandle) => e.body.text,
		path: ["body", "text"],
		lowered: "js/ctx.request.body.text",
		ctx: { body: { text: "hi" } },
		value: "hi",
	},
] as const;

describe("entry handles — all unary triggers root at ctx.request and lower like step() handles (#430)", () => {
	it.each(CASES)("$kind: emits {$ref}@@trigger → ctx.request.* → resolves to the right source", async (c) => {
		const wf = await workflowCallback("entry", { version: "1.0.0", trigger: c.trigger }, (entry: TriggerHandle) => {
			step("read", passthrough, { val: c.read(entry) });
		});
		const steps = wf._config.steps as Array<{ inputs: Record<string, unknown> }>;

		// (1) structural {$ref} rooted at the @trigger sentinel — same shape a step() handle uses.
		expect(steps[0].inputs.val).toEqual({ $ref: { step: "@trigger", path: [...c.path] } });
		// (2) lowers to ctx.REQUEST (not ctx.state) via the same lowerRefs pass.
		expect(lowerRefs(steps[0].inputs)).toEqual({ val: c.lowered });
		// (3) the REAL Mapper resolves it against a trigger-shaped ctx — right source, not undefined.
		expect(resolve(steps[0].inputs, triggerCtx(c.ctx)).val).toEqual(c.value);
	});

	it("entry-handle lowering uses the IDENTICAL {$ref}→lowerRefs path as step() handles — no two divergent paths", async () => {
		const wf = await workflowCallback(
			"parity",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const first = step("first", passthrough, { v: req.body.x }); // trigger leg → ctx.request
				step("second", passthrough, { v: first.y }); // step leg → ctx.state
			},
		);
		const steps = wf._config.steps as Array<{ inputs: Record<string, unknown> }>;

		// Both are {$ref}; only the root step differs (@trigger vs the producing step id).
		expect(steps[0].inputs.v).toEqual({ $ref: { step: "@trigger", path: ["body", "x"] } });
		expect(steps[1].inputs.v).toEqual({ $ref: { step: "first", path: ["y"] } });
		expect(lowerRefs(steps[0].inputs)).toEqual({ v: "js/ctx.request.body.x" });
		expect(lowerRefs(steps[1].inputs)).toEqual({ v: "js/ctx.state.first.y" });

		// Neither leaves a raw {$ref} object — which the string-only Mapper would silently pass through unresolved.
		expect(JSON.stringify(lowerRefs(steps[0].inputs))).not.toContain("$ref");
		expect(JSON.stringify(lowerRefs(steps[1].inputs))).not.toContain("$ref");
	});
});
