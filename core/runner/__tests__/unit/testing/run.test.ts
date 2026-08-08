/**
 * `runNode` / `runWorkflow` — the typed-first testing surface (#688).
 *
 * The workflows here are authored with the SAME handle DSL a consumer uses and
 * run through the REAL Configuration + Runner (WorkflowTestRunner's v2 path).
 * Nothing is stubbed except what a test explicitly mocks by node key.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../../src/defineNode";
import { type Handle, runtimeNode } from "../../../src/handles";
import { branch, gt, step, tpl, workflowCallback } from "../../../src/stepBuilder";
import { runNode, runWorkflow } from "../../../src/testing";

const validate = defineNode({
	name: "order-validator",
	description: "normalizes an order",
	input: z.object({ body: z.object({ id: z.string(), total: z.number() }) }),
	output: z.object({ id: z.string(), total: z.number() }),
	execute: (_ctx, input) => ({ id: input.body.id, total: input.body.total }),
});

const summarize = defineNode({
	name: "order-summary",
	description: "renders a one-line summary",
	input: z.object({ line: z.string() }),
	output: z.object({ summary: z.string() }),
	execute: (_ctx, input) => ({ summary: input.line }),
});

const flagVip = defineNode({
	name: "flag-vip",
	description: "marks an order as VIP",
	input: z.object({ id: z.string() }),
	output: z.object({ vip: z.boolean() }),
	execute: (_ctx, input) => ({ vip: input.id.length > 0 }),
});

const explode = defineNode({
	name: "explode",
	description: "always throws",
	input: z.object({}),
	output: z.object({}),
	execute: () => {
		throw new Error("kaboom");
	},
});

interface OrderBody {
	id: Handle<string>;
	total: Handle<number>;
}

/** The reference workflow: one real step, a template read, and a branch. */
function orderFlow(name: string) {
	return workflowCallback(name, { version: "1.0.0", trigger: { http: { method: "POST", path: "/orders" } } }, (req) => {
		const body = (req as unknown as { body: OrderBody }).body;
		const order = step("validate", validate, { body });
		step("summary", summarize, { line: tpl`order ${order.id}` });
		branch("big", gt(order.total, 100), {
			then: () => {
				step("vip", flagVip, { id: order.id });
			},
		});
	});
}

describe("runNode", () => {
	it("returns the node's typed output", async () => {
		const out = await runNode(validate, { body: { id: "o-1", total: 120 } });
		expect(out).toEqual({ id: "o-1", total: 120 });
	});

	it("passes context overrides through (env is visible to the node)", async () => {
		const reader = defineNode({
			name: "env-reader",
			description: "echoes an env var",
			input: z.object({}),
			output: z.object({ key: z.string() }),
			execute: (ctx) => ({ key: String((ctx.env as Record<string, unknown>).API_KEY) }),
		});
		expect(await runNode(reader, {}, { env: { API_KEY: "test" } })).toEqual({ key: "test" });
	});

	it("rejects when the node throws", async () => {
		await expect(runNode(explode, {})).rejects.toThrow(/kaboom/);
	});

	it("rejects when the input violates the node's Zod schema", async () => {
		await expect(runNode(validate, { body: { id: "o-1" } } as never)).rejects.toThrow(/total/);
	});
});

describe("runWorkflow", () => {
	it("accepts the workflow() export directly and reports state + response", async () => {
		const run = await runWorkflow(orderFlow("order-direct"), { id: "o-1", total: 120 });

		expect(run.ok).toBe(true);
		expect(run.state("validate")).toEqual({ id: "o-1", total: 120 });
		expect(run.state("vip")).toEqual({ vip: true });
		expect(run.response).toEqual({ vip: true });
	});

	it("exposes resolved inputs per step — the data flow, not just the outcome", async () => {
		const run = await runWorkflow(orderFlow("order-inputs"), { id: "o-2", total: 120 });

		// `{$ref}` on the trigger body, lowered and resolved by the real Mapper.
		expect(run.step("validate")?.inputs).toEqual({ body: { id: "o-2", total: 120 } });
		// `tpl` interpolation resolved against the producing step's state slot.
		expect(run.step("summary")?.inputs).toEqual({ line: "order o-2" });
		expect(run.step("summary")?.output).toEqual({ summary: "order o-2" });
	});

	it("reports an untaken branch arm as skipped", async () => {
		const run = await runWorkflow(orderFlow("order-small"), { id: "o-3", total: 5 });

		expect(run.ok).toBe(true);
		expect(run.step("validate")?.executed).toBe(true);
		expect(run.step("vip")?.executed).toBe(false);
		expect(run.state("vip")).toBeUndefined();
		// Declared order is preserved even for the arm that never ran.
		expect(run.steps.map((s) => s.id)).toEqual(["validate", "summary", "vip"]);
	});

	it("mocks a node by key", async () => {
		const run = await runWorkflow(
			orderFlow("order-mocked"),
			{ id: "o-4", total: 1 },
			{
				mock: { "order-validator": async () => ({ id: "mocked", total: 999 }) },
			},
		);

		expect(run.ok).toBe(true);
		expect(run.state("validate")).toEqual({ id: "mocked", total: 999 });
		// A mocked step reports like a real one — same id, same resolved inputs.
		expect(run.step("validate")?.executed).toBe(true);
		expect(run.step("validate")?.inputs).toEqual({ body: { id: "o-4", total: 1 } });
		// The mocked value flows on: the branch takes the `then` arm on 999.
		expect(run.step("vip")?.executed).toBe(true);
	});

	it("fails a mock that returns a field the node's output schema does not declare", async () => {
		await expect(
			runWorkflow(
				orderFlow("order-lying-mock"),
				{ id: "o-5", total: 1 },
				{
					mock: {
						"order-validator": async () => ({ id: "o-5", total: 1, readModelServed: null }),
					},
				},
			),
		).rejects.toThrow(/order-validator[\s\S]*readModelServed/);
	});

	it("fails a mock that omits a declared output field", async () => {
		await expect(
			runWorkflow(
				orderFlow("order-partial-mock"),
				{ id: "o-6", total: 1 },
				{
					mock: { "order-validator": async () => ({ id: "o-6" }) },
				},
			),
		).rejects.toThrow(/order-validator[\s\S]*total/);
	});

	it("reports a failed run instead of throwing, with the step state absent", async () => {
		const wf = workflowCallback(
			"order-boom",
			{ version: "1.0.0", trigger: { http: { method: "POST", path: "/b" } } },
			() => {
				step("bang", explode, {});
				step("after", summarize, { line: "never" });
			},
		);

		const run = await runWorkflow(wf, {});
		expect(run.ok).toBe(false);
		expect(String(run.error)).toMatch(/kaboom/);
		expect(run.state("bang")).toBeUndefined();
		expect(run.step("after")?.executed).toBe(false);
	});

	it("mocks a cross-runtime step by key (no sidecar)", async () => {
		const scorer = runtimeNode<{ text: string }, { score: number }>("score-model", "runtime.python3");
		const wf = workflowCallback(
			"order-runtime",
			{ version: "1.0.0", trigger: { http: { method: "POST", path: "/r" } } },
			(req) => {
				const body = req as unknown as { body: { text: Handle<string> } };
				step("score", scorer, { text: body.body.text });
			},
		);

		const run = await runWorkflow(wf, { text: "hello" }, { mock: { "score-model": async () => ({ score: 0.9 }) } });

		expect(run.ok).toBe(true);
		expect(run.state("score")).toEqual({ score: 0.9 });
		expect(run.step("score")?.inputs).toEqual({ text: "hello" });
	});

	it("names the unresolved node keys when nothing implements them", async () => {
		const wf = workflowCallback(
			"order-unknown",
			{ version: "1.0.0", trigger: { http: { method: "POST", path: "/u" } } },
			() => {
				step("ghost", { name: "not-a-real-node" }, {});
			},
		);

		await expect(runWorkflow(wf, {})).rejects.toThrow(/not-a-real-node/);
	});

	it("still runs a JSON workflow from a file path (back-compat)", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "blok-runworkflow-")), "wf.json");
		writeFileSync(
			file,
			JSON.stringify({
				name: "order-json",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/json" } },
				steps: [{ id: "validate", use: "order-validator", inputs: { body: "js/ctx.request.body" } }],
			}),
		);

		const run = await runWorkflow(file, { id: "o-7", total: 3 });
		expect(run.ok).toBe(true);
		expect(run.state("validate")).toEqual({ id: "o-7", total: 3 });
	});
});

/**
 * ADR 0015 (#678) — where the declared-`input` gate does and does not apply.
 *
 * The ADR scopes enforcement to the `TriggerBase.run()` chokepoint: a real
 * request arriving over a real transport. `runWorkflow` is NOT that chokepoint —
 * it drives `WorkflowTestRunner` directly, the same position `SubworkflowNode`
 * occupies, which the ADR also leaves ungated. The ADR is silent on the testing
 * path, so this pins the consequence as a DECISION rather than an accident:
 * `runWorkflow(wf, input)` runs the payload the test author wrote, verbatim.
 *
 * Practical read: `runWorkflow` tests the workflow BODY. To test the input
 * contract itself, `safeParse` with the schema in the test (it is a plain Zod
 * object) or exercise the transport.
 */
describe("runWorkflow — declared `input` is NOT enforced (ADR 0015 scope)", () => {
	const strictFlow = workflowCallback(
		"order-strict",
		{
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/strict" } },
			input: z.object({ id: z.string(), total: z.number(), currency: z.string().default("usd") }),
		},
		(req) => {
			const body = (req as unknown as { body: OrderBody }).body;
			step("validate", validate, { body });
		},
	);

	it("does not reject a payload the HTTP gate would 400", async () => {
		// `total` is a string and `id` is missing — a 400 at the trigger boundary.
		const run = await runWorkflow(strictFlow, { total: "not-a-number" });

		// The gate never ran; the run failed (or not) purely on the node's own
		// Zod, exactly as it did before ADR 0015. What matters is the ABSENCE of
		// a workflow-input 400 short-circuit.
		expect(String(run.error ?? "")).not.toMatch(/input validation failed/i);
	});

	it("does not apply declared `.default()` values to the entry payload", async () => {
		const run = await runWorkflow(strictFlow, { id: "o-9", total: 5 });

		expect(run.ok).toBe(true);
		// `currency` would be defaulted to "usd" by the transport gate; here the
		// node sees exactly what the test passed.
		expect(run.step("validate")?.inputs).toEqual({ body: { id: "o-9", total: 5 } });
	});
});
