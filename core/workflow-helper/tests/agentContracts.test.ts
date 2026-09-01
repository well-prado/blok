import { describe, expect, it } from "vitest";
import {
	AgentBudgetSchema,
	AgentPhaseSchema,
	CompletionContractSchema,
	V2AgentStepSchema,
	V2ApprovalStepSchema,
	V2AssertStepSchema,
	V2CompletionStepSchema,
	V2EvidenceStepSchema,
	WorkflowIRSchema,
} from "../src/index";

const phase = { name: "implement", capabilities: ["workspace.read", "workspace.write"], effects: ["read", "write"] };
const artifact = {
	producer: { kind: "capability", name: "workspace.test" },
	artifact: { id: "test-report", version: "commit-123", contentHash: "sha256:abc" },
	verification: { verifier: "test-runner", status: "pending" },
};

describe("H1-02 agent workflow IR contracts", () => {
	it("validates bounded phase, budget, and completion contracts", () => {
		expect(AgentPhaseSchema.parse(phase)).toEqual({ ...phase, secrets: [] });
		expect(AgentBudgetSchema.parse({ maxTurns: 5 })).toEqual({ maxTurns: 5 });
		expect(CompletionContractSchema.parse({ required: ["tests-pass"] })).toEqual({ required: ["tests-pass"] });
	});

	it("accepts each new step discriminator and rejects model prose as evidence", () => {
		expect(
			V2AgentStepSchema.safeParse({
				id: "implement",
				agentStep: { objective: "Implement the requested change.", phase, completion: { required: ["tests-pass"] } },
				inputs: { task: { $ref: { step: "@trigger", path: ["body", "task"] } } },
			}),
		).toHaveProperty("success", true);
		expect(V2ApprovalStepSchema.safeParse({ id: "approve", approval: { prompt: "Approve the plan?" } }).success).toBe(
			true,
		);
		expect(V2EvidenceStepSchema.safeParse({ id: "tests", evidence: artifact }).success).toBe(true);
		expect(V2AssertStepSchema.safeParse({ id: "tests-pass", assert: { evidence: "tests" } }).success).toBe(true);
		expect(V2CompletionStepSchema.safeParse({ id: "done", completion: { required: ["tests-pass"] } }).success).toBe(
			true,
		);
		expect(
			V2EvidenceStepSchema.safeParse({
				id: "fake",
				evidence: { ...artifact, proof: "the model says all tests passed" },
			}).success,
		).toBe(false);
	});

	it("rejects future or malformed gate contracts with actionable paths", () => {
		const invalid = V2AssertStepSchema.safeParse({ id: "gate", assert: { condition: "ctx.state.tests.ok" } });
		expect(invalid.success).toBe(false);
		const future = WorkflowIRSchema.safeParse({
			name: "Agent Contract Workflow",
			version: "1.0.0",
			schemaVersion: "3",
			trigger: { http: { method: "POST" } },
			steps: [{ id: "done", completion: { required: ["gate"] } }],
		});
		expect(future.success).toBe(false);
	});
});
