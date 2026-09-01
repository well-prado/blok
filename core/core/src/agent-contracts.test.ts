import { assert, agentStep, approval, completion, defineNode, evidence, step, workflow } from "@blokjs/core";
import { WorkflowIRSchema } from "@blokjs/helper";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const checkNode = defineNode({
	name: "agent-contract-check",
	input: z.object({ target: z.string() }),
	output: z.object({ passed: z.boolean() }),
	execute: async () => ({ passed: true }),
});

describe("@blokjs/core enforced-agent authoring", () => {
	it("lowers handles and Zod schemas into serializable IR", async () => {
		const built = await workflow(
			"Agent Contract Workflow",
			{ version: "1.0.0", trigger: { http: { method: "POST", path: "/agent-contract" } } },
			(req) => {
				const check = step("check", checkNode, { target: req.body.target });
				const report = evidence("test-report", {
					producer: check,
					artifact: { id: "test-report", version: "run-1" },
					verification: { verifier: "test-runner", status: "pending" },
				});
				const passed = assert("tests-pass", report);
				const plan = agentStep(
					"implement",
					"Implement the requested change.",
					{ target: req.body.target },
					{
						phase: { name: "implement", capabilities: ["workspace.read"], effects: ["read"] },
						budgets: { maxTurns: 3 },
						outputSchema: z.object({ summary: z.string() }),
						completion: { required: [passed] },
					},
				);
				approval("approve", {
					prompt: "Approve the change?",
					inputs: { plan },
					outputSchema: z.object({ approved: z.boolean() }),
				});
				completion("done", { required: [passed] });
			},
		);

		const serialized = built.toJson();
		const ir = JSON.parse(serialized) as { steps: Array<Record<string, unknown>> };
		expect(serialized).not.toContain("_def");
		expect(WorkflowIRSchema.safeParse(ir).success).toBe(true);
		expect(ir.steps.map((item) => Object.keys(item).find((key) => key !== "id"))).toEqual([
			"use",
			"evidence",
			"assert",
			"agentStep",
			"approval",
			"completion",
		]);
		expect((ir.steps[3]?.agentStep as Record<string, unknown>).outputSchema).toMatchObject({ type: "object" });
		expect((ir.steps[4]?.inputs as Record<string, unknown>).plan).toEqual({ $ref: { step: "implement", path: [] } });
	});

	it("rejects an agent step without a phase or completion contract", async () => {
		await expect(
			workflow("Invalid Agent Workflow", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				agentStep("missing-contract", "Do work", {}, undefined);
			}),
		).rejects.toThrow(/phase and completion contract/);
	});
});
