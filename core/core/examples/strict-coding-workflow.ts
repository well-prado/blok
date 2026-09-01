/**
 * Reference strict coding procedure for the H1-02 harness slice.
 *
 * The model-facing phases are ordinary nodes today so this fixture can be
 * exercised with `runWorkflow(..., { mock })`. The assertion, evidence, and
 * completion nodes are deterministic nodes: their outputs are derived from
 * typed inputs and cannot be supplied by model prose. The `approve` step is
 * policy-gated; H1-01's durable interaction port suspends it before the node
 * executes and TriggerBase resumes the run after the answer is recorded.
 */
import { http, type Handle, defineNode, step, workflow } from "@blokjs/core";
import { z } from "zod";

const artifactSchema = z.object({
	uri: z.string(),
	version: z.string(),
	digest: z.string(),
});

const evidenceSchema = z.object({
	producer: z.literal("trusted-test"),
	artifact: artifactSchema,
	verification: z.enum(["passed", "failed"]),
	checks: z.array(z.string()),
});

const modelManifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: [],
	capabilities: ["model.inference"],
	secrets: [],
	determinism: "external" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

const approvalManifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: [],
	capabilities: ["workflow.approval"],
	secrets: [],
	determinism: "deterministic" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

const implementationManifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: ["filesystem"] as const,
	capabilities: ["workspace.write"],
	secrets: [],
	determinism: "external" as const,
	idempotency: "conditionally-idempotent" as const,
	maturity: "stable" as const,
};

const testManifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: ["read"] as const,
	capabilities: ["workspace.test"],
	secrets: [],
	determinism: "deterministic" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

const gateManifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: [],
	capabilities: ["workflow.gate"],
	secrets: [],
	determinism: "deterministic" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

export const understandModel = defineNode({
	name: "harness.model.understand",
	description: "Produces the structured repository understanding phase.",
	capabilityManifest: modelManifest,
	input: z.object({ objective: z.string() }),
	output: z.object({
		phase: z.literal("understand"),
		objective: z.string(),
		observations: z.array(z.string()),
		modelClaimedEvidence: z.unknown().optional(),
	}),
	execute: async (_ctx, input) => ({
		phase: "understand" as const,
		objective: input.objective,
		observations: ["Reference fixture uses a typed, ordered workflow."],
		modelClaimedEvidence: { producer: "model", verification: "passed" },
	}),
});

export const planModel = defineNode({
	name: "harness.model.plan",
	description: "Produces the structured implementation plan phase.",
	capabilityManifest: modelManifest,
	input: z.object({ objective: z.string(), observations: z.array(z.string()) }),
	output: z.object({
		phase: z.literal("plan"),
		planId: z.string(),
		summary: z.string(),
	}),
	execute: async (_ctx, input) => ({
		phase: "plan" as const,
		planId: "plan-reference-1",
		summary: `Implement: ${input.objective}`,
	}),
});

export const approvalGate = defineNode({
	name: "harness.approval",
	description: "Records the approved plan after the policy boundary allows it.",
	capabilityManifest: approvalManifest,
	input: z.object({ planId: z.string(), summary: z.string() }),
	output: z.object({ phase: z.literal("approve"), approved: z.literal(true), planId: z.string() }),
	execute: async (_ctx, input) => ({ phase: "approve" as const, approved: true as const, planId: input.planId }),
});

export const implementModel = defineNode({
	name: "harness.model.implement",
	description: "Produces a proposed implementation artifact descriptor.",
	capabilityManifest: implementationManifest,
	input: z.object({ planId: z.string(), approved: z.literal(true) }),
	output: z.object({
		phase: z.literal("implement"),
		artifact: artifactSchema,
		modelClaimedEvidence: z.unknown().optional(),
	}),
	execute: async (_ctx, input) => ({
		phase: "implement" as const,
		artifact: { uri: "src/app.ts", version: "v1", digest: "sha256:good" },
		modelClaimedEvidence: { producer: "model", verification: "passed" },
	}),
});

/** Trusted test output: it does not read a model-provided `passed` field. */
export const testCapability = defineNode({
	name: "harness.test",
	description: "Verifies the proposed artifact and emits trusted evidence.",
	capabilityManifest: testManifest,
	input: z.object({ artifact: artifactSchema }),
	output: evidenceSchema,
	execute: async (_ctx, input) => {
		const validArtifact =
			input.artifact.uri === "src/app.ts" && input.artifact.version === "v1" && input.artifact.digest === "sha256:good";
		return {
			producer: "trusted-test" as const,
			artifact: input.artifact,
			verification: validArtifact ? ("passed" as const) : ("failed" as const),
			checks: validArtifact ? ["unit-tests", "typecheck"] : ["artifact-integrity"],
		};
	},
});

export const assertionGate = defineNode({
	name: "harness.assertion",
	description: "Requires the trusted test evidence to pass.",
	capabilityManifest: gateManifest,
	input: z.object({ evidence: evidenceSchema }),
	output: z.object({ phase: z.literal("assert"), passed: z.boolean() }),
	execute: async (_ctx, input) => {
		if (input.evidence.verification !== "passed" || input.evidence.checks.length === 0)
			throw new Error("assertion gate rejected unverified test evidence");
		return { phase: "assert" as const, passed: true };
	},
});

export const evidenceGate = defineNode({
	name: "harness.evidence",
	description: "Accepts only evidence produced by the trusted test capability.",
	capabilityManifest: gateManifest,
	input: z.object({
		modelUnderstanding: z.object({
			phase: z.literal("understand"),
			objective: z.string(),
			observations: z.array(z.string()),
			modelClaimedEvidence: z.unknown().optional(),
		}),
		evidence: evidenceSchema,
		assertion: z.object({ phase: z.literal("assert"), passed: z.literal(true) }),
	}),
	output: z.object({
		phase: z.literal("evidence"),
		verified: z.literal(true),
		producer: z.literal("trusted-test"),
		artifact: artifactSchema,
		version: z.string(),
	}),
	execute: async (_ctx, input) => {
		if (input.evidence.producer !== "trusted-test") throw new Error("evidence producer is not trusted");
		if (input.evidence.verification !== "passed") throw new Error("evidence verification did not pass");
		if (!input.assertion.passed) throw new Error("evidence requires a passing assertion");
		return {
			phase: "evidence" as const,
			verified: true as const,
			producer: "trusted-test" as const,
			artifact: input.evidence.artifact,
			version: input.evidence.artifact.version,
		};
	},
});

export const reviewModel = defineNode({
	name: "harness.model.review",
	description: "Produces the final review phase after all gates have run.",
	capabilityManifest: modelManifest,
	input: z.object({ planId: z.string(), artifact: artifactSchema, evidence: z.object({ verified: z.literal(true) }) }),
	output: z.object({ phase: z.literal("review"), accepted: z.literal(true), summary: z.string() }),
	execute: async (_ctx, input) => ({
		phase: "review" as const,
		accepted: true as const,
		summary: `Reviewed ${input.artifact.uri} for ${input.planId}`,
	}),
});

export const completionGate = defineNode({
	name: "harness.complete",
	description: "Enforces the strict workflow completion contract.",
	capabilityManifest: gateManifest,
	input: z.object({
		understand: z.literal("understand"),
		plan: z.literal("plan"),
		approve: z.literal("approve"),
		implement: z.literal("implement"),
		test: z.literal("trusted-test"),
		assert: z.literal(true),
		evidence: z.literal(true),
		review: z.literal("review"),
	}),
	output: z.object({
		phase: z.literal("complete"),
		completed: z.literal(true),
		evidenceProducer: z.literal("trusted-test"),
	}),
	execute: async (_ctx, input) => ({
		phase: "complete" as const,
		completed: true as const,
		evidenceProducer: input.test,
	}),
});

export default workflow(
	"strict-coding-reference",
	{ version: "1.0.0", trigger: http.post("/harness/strict-coding") },
	(req) => {
		const body = req.body as Handle<{ objective: string }>;
		const understanding = step("understand", understandModel, { objective: body.objective });
		const plan = step("plan", planModel, {
			objective: understanding.objective,
			observations: understanding.observations,
		});
		const approval = step("approve", approvalGate, { planId: plan.planId, summary: plan.summary });
		const implementation = step("implement", implementModel, { planId: plan.planId, approved: approval.approved });
		const evidence = step("test", testCapability, { artifact: implementation.artifact });
		const assertion = step("assert", assertionGate, { evidence });
		const verifiedEvidence = step("evidence", evidenceGate, {
			modelUnderstanding: understanding,
			evidence,
			assertion,
		});
		const review = step("review", reviewModel, {
			planId: plan.planId,
			artifact: implementation.artifact,
			evidence: verifiedEvidence,
		});
		step("complete", completionGate, {
			understand: understanding.phase,
			plan: plan.phase,
			approve: approval.phase,
			implement: implementation.phase,
			test: evidence.producer,
			assert: assertion.passed,
			evidence: verifiedEvidence.verified,
			review: review.phase,
		});
	},
);
