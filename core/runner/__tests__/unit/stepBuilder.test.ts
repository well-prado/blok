/**
 * End-to-end proof for the handle-DSL cornerstone (#421):
 *
 *   author via callback workflow() + step() handles
 *     → IR carries structural { $ref }
 *     → lowerRefs (the REAL load-boundary pass) compiles them to wire strings
 *     → the REAL Mapper resolves those strings against a live ctx
 *     → the REAL node executes, output persisted via the REAL applyStepOutput
 *     → the chained value comes out correct.
 *
 * Plus the two builder-stack guards: step() outside a callback throws, and a
 * duplicate id throws.
 *
 * The e2e drives the AUTHENTIC runner wire path — @blokjs/shared's real
 * `lowerRefs` + `mapper` and the runner's real `applyStepOutput` — against a
 * ctx built EXACTLY as `TriggerBase.createContext` does: the trigger payload
 * lives at `ctx.request` and `ctx.state` STARTS EMPTY. (WorkflowTestRunner is
 * deliberately NOT used here — it bypasses both lowerRefs and the Mapper and
 * never auto-persists to ctx.state, so it can't prove the trigger-input leg.)
 *
 * The trigger-input leg (`req.body.name`) MUST resolve via `ctx.request` — if
 * lowering ever re-roots `@trigger` at `ctx.state["@trigger"]` (the blocker
 * this PR fixes), the first step resolves to undefined and this test fails.
 */

import { type Context, lowerRefs, mapper } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../src/defineNode";
import {
	type CronEntry,
	type GrpcEntry,
	type HttpEntry,
	type PubSubEntry,
	type TriggerHandle,
	type WebhookEntry,
	type WorkerEntry,
	step,
	tpl,
	workflowCallback,
} from "../../src/stepBuilder";
// The REAL persistence pass the runner uses after every step (Rules 0–3).
import { applyStepOutput } from "../../src/workflow/PersistenceHelper";

/**
 * Build a ctx the way TriggerBase.createContext does: payload at ctx.request,
 * ctx.state STARTS EMPTY (no `@trigger` slot — the runner never writes one).
 */
function createTriggerCtx(body: Record<string, unknown>): Context {
	return {
		state: {} as Record<string, unknown>,
		request: { body, headers: {}, query: {}, params: {} },
		response: { data: null, error: null, success: true },
		workflow_name: "stepBuilder-e2e",
		config: {},
		func: {},
		vars: {},
	} as unknown as Context;
}

/**
 * Run one collected step the way the runner does: lower its {$ref} inputs to
 * wire strings, resolve them through the REAL Mapper against the live ctx,
 * execute the REAL node, and persist via the REAL applyStepOutput. Returns the
 * node's data envelope so the caller can assert the chained value.
 */
async function runStep(
	ctx: Context,
	rec: { id: string; use?: string; inputs?: Record<string, unknown>; ephemeral?: boolean },
	node: { name: string; handle: (ctx: Context, input: Record<string, unknown>) => Promise<unknown> },
): Promise<void> {
	const inputs = lowerRefs(rec.inputs ?? {}) as Record<string, unknown>;
	// The Mapper resolves against ctx; request body is the second arg (the data
	// root used for `${...}` interpolation), mirroring NodeBase.process.
	mapper.replaceObjectStrings(inputs, ctx, ctx.request.body as never);
	const res = (await node.handle(ctx, inputs)) as { success: boolean; data: Record<string, unknown> };
	expect(res.success).toBe(true);
	// REAL persistence — output lands at ctx.state[rec.id] (Rule 3 default);
	// Rule 1 skips persistence when the step is ephemeral.
	applyStepOutput(ctx, { name: rec.id, ephemeral: rec.ephemeral }, res);
}

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

const echoUrl = defineNode({
	name: "echo-url",
	description: "echo a url back",
	input: z.object({ url: z.string() }),
	output: z.object({ url: z.string() }),
	execute: (_ctx, input) => ({ url: input.url }),
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

		// (a) the emitted IR carries structural {$ref} — NOT yet wire strings.
		//     The trigger-input leg roots at the `@trigger` sentinel.
		expect(steps[0].inputs.name).toEqual({ $ref: { step: "@trigger", path: ["body", "name"] } });
		expect(steps[1].inputs.message).toEqual({ $ref: { step: "greet", path: ["greeting"] } });
		expect(steps[2].inputs.name).toEqual({ $ref: { step: "shout", path: ["loud"] } });

		// (b) the REAL lowerRefs compiles {$ref} into the wire strings the engine
		//     resolves. The trigger leg lowers to ctx.REQUEST (not ctx.state) —
		//     this is the blocker fix. The intra-chain legs lower to ctx.state.
		expect(lowerRefs(steps[0].inputs)).toEqual({ name: "js/ctx.request.body.name" });
		expect(lowerRefs(steps[1].inputs)).toEqual({ message: "js/ctx.state.greet.greeting" });
		expect(lowerRefs(steps[2].inputs)).toEqual({ name: "js/ctx.state.shout.loud" });

		// (c) drive the REAL wire path: ctx built like TriggerBase.createContext
		//     (payload at ctx.request, state STARTS EMPTY — no `@trigger` slot).
		//     Each step: lower → Mapper → node.handle → applyStepOutput, exactly
		//     as NodeBase.process + PersistenceHelper do. The trigger leg only
		//     resolves because lowerRefs roots `@trigger` at ctx.request.
		const ctx = createTriggerCtx({ name: "ada" });
		const nodes = [greet, shout, greet];
		for (let i = 0; i < steps.length; i++) {
			await runStep(ctx, steps[i], nodes[i]);
		}

		const state = ctx.state as Record<string, unknown>;
		// Trigger leg actually resolved (NOT undefined) — proves the blocker fix.
		expect(state.greet).toEqual({ greeting: "Hello, ada!" });
		// Intra-chain legs.
		expect(state.shout).toEqual({ loud: "HELLO, ADA!" });
		expect(state.respond).toEqual({ greeting: "Hello, HELLO, ADA!!" });
		// And ctx.state never got a phantom `@trigger` slot.
		expect(state["@trigger"]).toBeUndefined();
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

	it("tpl: captures {$tpl} with a {$ref} segment, lowers to a js/`…` literal, resolves through the REAL Mapper", async () => {
		const wf = await workflowCallback(
			"Stock Check",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const validate = step("validate", greet, { name: req.body.name });
				// tpl interpolates a handle into a string — captured structurally,
				// no toString coercion (the poison would throw otherwise).
				step("fetch", echoUrl, { url: tpl`https://h/${validate.greeting}` });
			},
		);

		const steps = wf._config.steps as Array<{ id: string; inputs: Record<string, unknown> }>;

		// (a) IR carries {$tpl} with a {$ref} segment — pre-lowering, structural.
		expect(steps[1].inputs.url).toEqual({
			$tpl: ["https://h/", { $ref: { step: "validate", path: ["greeting"] } }, ""],
		});

		// (b) lowerRefs compiles it to a js/`…${ctx.state…}…` template literal.
		expect(lowerRefs(steps[1].inputs)).toEqual({
			url: "js/`https://h/${ctx.state.validate.greeting}`",
		});

		// (c) drive the REAL wire path end-to-end.
		const ctx = createTriggerCtx({ name: "ada" });
		await runStep(ctx, steps[0], greet);
		await runStep(ctx, steps[1], echoUrl);

		const state = ctx.state as Record<string, unknown>;
		expect(state.validate).toEqual({ greeting: "Hello, ada!" });
		expect(state.fetch).toEqual({ url: "https://h/Hello, ada!" });
	});

	it("tpl: falsy interpolation (0) preserved, not blanked, end-to-end", async () => {
		const zero = defineNode({
			name: "zero",
			description: "emit a zero",
			input: z.object({}),
			output: z.object({ n: z.number() }),
			execute: () => ({ n: 0 }),
		});
		const wf = await workflowCallback("Zero", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const z0 = step("z", zero, {});
			step("fetch", echoUrl, { url: tpl`n=${z0.n}` });
		});
		const steps = wf._config.steps as Array<{ id: string; inputs: Record<string, unknown> }>;
		const ctx = createTriggerCtx({});
		await runStep(ctx, steps[0], zero);
		await runStep(ctx, steps[1], echoUrl);
		expect((ctx.state as Record<string, unknown>).fetch).toEqual({ url: "n=0" });
	});

	it("POISON: a bare handle in an UNTAGGED template literal throws (loud, not silent)", async () => {
		await expect(
			workflowCallback("Poison", { version: "1.0.0", trigger: { http: { method: "POST" } } }, (req: TriggerHandle) => {
				const validate = step("validate", greet, { name: req.body.name });
				// Untagged template literal coerces the handle to a string → throws.
				step("fetch", echoUrl, { url: `https://h/${validate.greeting}` });
			}),
		).rejects.toThrow(/use tpl`/i);
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

describe("ephemeral handle: unreadable/poisoned (#339)", () => {
	const log = defineNode({
		name: "log",
		description: "side-effect only",
		input: z.object({ message: z.string() }),
		output: z.object({ logged: z.boolean() }),
		execute: () => ({ logged: true }),
	});

	it("still emits the step with ephemeral:true (UNCHANGED runtime)", async () => {
		const wf = await workflowCallback(
			"Ephemeral Emit",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				step("log", log, { message: req.body.message }, { ephemeral: true });
			},
		);
		const steps = wf._config.steps as Array<{ id: string; ephemeral?: boolean }>;
		expect(steps[0].id).toBe("log");
		expect(steps[0].ephemeral).toBe(true);
	});

	it("reading a field on the ephemeral handle THROWS the clear error", async () => {
		await expect(
			workflowCallback("Ephemeral Read", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const logged = step("log", log, { message: "x" }, { ephemeral: true });
				// @ts-expect-error — EphemeralHandle exposes no readable members.
				void logged.logged;
			}),
		).rejects.toThrow(/Step "log" is ephemeral — its output is not persisted to state and has no readable handle/);
	});

	it("using the ephemeral handle as another step's input THROWS", async () => {
		await expect(
			workflowCallback("Ephemeral Input", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const logged = step("log", log, { message: "x" }, { ephemeral: true });
				// The whole-handle ref is detected at lowerHandles → throws.
				step("shout", shout, { message: logged as unknown as string });
			}),
		).rejects.toThrow(/Step "log" is ephemeral/);
	});

	it("a NORMAL (non-ephemeral) handle still resolves through the REAL wire path (no regression)", async () => {
		const wf = await workflowCallback(
			"Normal After Ephemeral",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				step("log", log, { message: req.body.name }, { ephemeral: true });
				const greeting = step("greet", greet, { name: req.body.name });
				step("shout", shout, { message: greeting.greeting });
			},
		);
		const steps = wf._config.steps as Array<{ id: string; use: string; inputs: Record<string, unknown> }>;
		// Normal handle lowered exactly as today.
		expect(lowerRefs(steps[2].inputs)).toEqual({ message: "js/ctx.state.greet.greeting" });

		const ctx = createTriggerCtx({ name: "ada" });
		// Honor Rule 1: the ephemeral step skips persistence (the runtime is unchanged
		// — this task only poisons the author-facing handle).
		await runStep(ctx, { ...steps[0], ephemeral: true }, log);
		await runStep(ctx, steps[1], greet);
		await runStep(ctx, steps[2], shout);
		const state = ctx.state as Record<string, unknown>;
		// Ephemeral step skipped persistence (Rule 1) — not in state.
		expect(state.log).toBeUndefined();
		// Normal chain resolved correctly.
		expect(state.greet).toEqual({ greeting: "Hello, ada!" });
		expect(state.shout).toEqual({ loud: "HELLO, ADA!" });
	});
});

// ───────────────── per-trigger ENTRY handles (#336) ─────────────────
//
// All request-shaped triggers funnel into ctx.request, so EVERY entry handle
// lowers through the same `@trigger` → ctx.request root — the per-kind
// difference is the author-facing NAME + TYPE, not the runtime mapping.

describe("handle-DSL e2e: per-trigger entry handles (#336)", () => {
	it("cron `tick` reads lower to ctx.request and resolve through the REAL Mapper", async () => {
		const wf = await workflowCallback(
			"Cron Tick",
			{ version: "1.0.0", trigger: { cron: { expression: "* * * * *" } } },
			// `tick` — cron entry handle. Has no body; read params (the schedule slot).
			(tick) => {
				step("greet", greet, { name: tick.params.who });
			},
		);
		const steps = wf._config.steps as Array<{ id: string; inputs: Record<string, unknown> }>;
		// Lowers through the SAME @trigger root → ctx.request.
		expect(lowerRefs(steps[0].inputs)).toEqual({ name: "js/ctx.request.params.who" });

		// The cron payload funnels into ctx.request just like HTTP.
		const ctx = createTriggerCtx({});
		(ctx.request as { params: Record<string, string> }).params = { who: "scheduler" };
		await runStep(ctx, steps[0], greet);
		expect((ctx.state as Record<string, unknown>).greet).toEqual({ greeting: "Hello, scheduler!" });
	});

	it("worker `job.body.x` lowers to ctx.request.body.x and resolves", async () => {
		const wf = await workflowCallback(
			"Worker Job",
			{ version: "1.0.0", trigger: { worker: { queue: "jobs" } } },
			// `job` — worker entry handle. Payload in body; metadata in params.
			(job) => {
				step("greet", greet, { name: job.body.name });
			},
		);
		const steps = wf._config.steps as Array<{ id: string; inputs: Record<string, unknown> }>;
		expect(lowerRefs(steps[0].inputs)).toEqual({ name: "js/ctx.request.body.name" });

		const ctx = createTriggerCtx({ name: "worker" });
		await runStep(ctx, steps[0], greet);
		expect((ctx.state as Record<string, unknown>).greet).toEqual({ greeting: "Hello, worker!" });
	});

	it("pubsub `msg.body.x` lowers to ctx.request.body.x and resolves", async () => {
		const wf = await workflowCallback(
			"PubSub Msg",
			{ version: "1.0.0", trigger: { pubsub: { topic: "events" } } },
			// `msg` — pubsub entry handle. Message payload in body.
			(msg) => {
				step("greet", greet, { name: msg.body.name });
			},
		);
		const steps = wf._config.steps as Array<{ id: string; inputs: Record<string, unknown> }>;
		expect(lowerRefs(steps[0].inputs)).toEqual({ name: "js/ctx.request.body.name" });

		const ctx = createTriggerCtx({ name: "subscriber" });
		await runStep(ctx, steps[0], greet);
		expect((ctx.state as Record<string, unknown>).greet).toEqual({ greeting: "Hello, subscriber!" });
	});

	// TYPE-TEST: each trigger kind yields the right entry-handle TYPE. These are
	// compile-time assertions — `tsc` (the runner typecheck target) fails if a
	// kind maps to the wrong handle. No runtime assertions needed.
	it("type-test: each trigger kind maps to the correct entry handle", async () => {
		type Expect<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
		const assert = <T extends true>(_v?: T): void => {};

		await workflowCallback("T-http", { version: "1.0.0", trigger: { http: { method: "GET" as const } } }, (req) => {
			assert<Expect<typeof req, HttpEntry>>();
			// http has a body.
			void req.body;
		});
		await workflowCallback(
			"T-webhook",
			{ version: "1.0.0", trigger: { webhook: { provider: "stripe" as const } } },
			(event) => {
				assert<Expect<typeof event, WebhookEntry>>();
				void event.body;
			},
		);
		await workflowCallback(
			"T-cron",
			{ version: "1.0.0", trigger: { cron: { expression: "* * * * *" } } },
			(tick) => {
				assert<Expect<typeof tick, CronEntry>>();
				// cron has NO body — `tick.body` must be a compile error (no phantom body).
				// @ts-expect-error — cron tick exposes no `.body`.
				void tick.body;
				void tick.params;
			},
		);
		await workflowCallback("T-worker", { version: "1.0.0", trigger: { worker: { queue: "q" } } }, (job) => {
			assert<Expect<typeof job, WorkerEntry>>();
			void job.body;
			// Worker metadata is typed on params.
			void job.params.jobId;
			void job.params.attempt;
		});
		await workflowCallback("T-pubsub", { version: "1.0.0", trigger: { pubsub: { topic: "t" } } }, (msg) => {
			assert<Expect<typeof msg, PubSubEntry>>();
			void msg.body;
		});
		await workflowCallback("T-grpc", { version: "1.0.0", trigger: { grpc: { service: "S", method: "M" } } }, (rpc) => {
			assert<Expect<typeof rpc, GrpcEntry>>();
			void rpc.body;
		});
		// Unrecognized / out-of-scope kind (manual, #362) falls back to the loose handle.
		await workflowCallback("T-manual", { version: "1.0.0", trigger: { manual: {} } }, (args) => {
			assert<Expect<typeof args, TriggerHandle>>();
			void args.anything;
		});
	});
});
