import type { Context, PolicyEvaluationResult } from "@blokjs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import Runner from "../../Runner";
import { defineNode } from "../../defineNode";
import {
	InMemoryAuditSink,
	InMemoryPolicyProvider,
	PolicyInteractionRequiredError,
	installPolicyExecution,
} from "../../index";
import { DurableInteractionPort, InMemoryInteractionStore } from "../../policy/InteractionStore";
import { RunTracker } from "../../tracing/RunTracker";

const agentManifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: ["read"] as const,
	capabilities: ["workspace.read"] as const,
	secrets: [] as const,
	determinism: "external" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};
const trustedManifest = { ...agentManifest, determinism: "deterministic" as const };

function context(nodeName: string, input: unknown): Context {
	const state: Record<string, unknown> = {};
	return {
		id: "run-1",
		workflow_name: "enforcement-test",
		workflow_path: "<test>",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { success: true, data: null, error: null },
		error: { message: [] },
		logger: { log: () => undefined, logLevel: () => undefined } as Context["logger"],
		config: { [nodeName]: { inputs: input } },
		eventLogger: null,
		state,
		vars: state,
		_PRIVATE_: {},
	} as Context;
}

function policy(auditSink: InMemoryAuditSink, result?: PolicyEvaluationResult) {
	return {
		principal: { id: "principal-1", kind: "test" },
		session: { id: "session-1" },
		turn: { id: "turn-1" },
		policyVersion: "test-v1",
		provider: new InMemoryPolicyProvider(
			async () =>
				result ?? {
					decision: { kind: "allow", id: "decision-1", reasonCode: "allowed", policyVersion: "test-v1" },
					matchedRules: [],
				},
		),
		auditSink,
	};
}

describe("H1-02 runner enforcement", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	it("requires an explicit agent completion signal before state publication", async () => {
		const node = defineNode({
			name: "agent",
			description: "model step",
			input: z.object({}),
			output: z.object({ completed: z.boolean(), answer: z.string() }),
			capabilityManifest: agentManifest,
			agentStep: { version: "1", objective: "inspect", completion: { path: "completed" } },
			execute: async () => ({ completed: true, answer: "done" }),
		});
		const ctx = context(node.name, {});
		installPolicyExecution(ctx, policy(new InMemoryAuditSink()));

		await new Runner([node]).run(ctx);

		expect(ctx.state?.agent).toEqual({ completed: true, answer: "done" });
	});

	it("rejects incomplete model output without publishing the step", async () => {
		const node = defineNode({
			name: "agent",
			description: "model step",
			input: z.object({}),
			output: z.object({ completed: z.boolean() }),
			capabilityManifest: agentManifest,
			agentStep: { version: "1", objective: "inspect", completion: { path: "completed" } },
			execute: async () => ({ completed: false }),
		});
		const ctx = context(node.name, {});
		installPolicyExecution(ctx, policy(new InMemoryAuditSink()));

		await expect(new Runner([node]).run(ctx)).rejects.toThrow(/AGENT_STEP_INCOMPLETE/);
		expect(ctx.state?.agent).toBeUndefined();
	});

	it("does not retry a rejected completion gate", async () => {
		let calls = 0;
		const node = defineNode({
			name: "agent",
			description: "model step",
			input: z.object({}),
			output: z.object({ completed: z.boolean() }),
			capabilityManifest: agentManifest,
			agentStep: { version: "1", objective: "inspect", completion: { path: "completed" } },
			execute: async () => {
				calls += 1;
				return { completed: false };
			},
		});
		const ctx = context(node.name, {});
		installPolicyExecution(ctx, policy(new InMemoryAuditSink()));
		(ctx.config as Record<string, unknown>)[node.name] = { inputs: {}, retry: { maxAttempts: 3 } };
		node.retry = { maxAttempts: 3 };

		await expect(new Runner([node]).run(ctx)).rejects.toThrow(/AGENT_STEP_INCOMPLETE/);
		expect(calls).toBe(1);
	});

	it("rejects model output at an evidence gate before publication", async () => {
		const node = defineNode({
			name: "evidence",
			description: "model evidence claim",
			input: z.object({}),
			output: z.object({ evidence: z.array(z.unknown()) }),
			capabilityManifest: agentManifest,
			evidenceGate: {
				version: "1",
				requirements: [{ artifactId: "tests", artifactVersion: "1", producerStepId: "run-tests" }],
			},
			execute: async () => ({
				evidence: [
					{
						version: "1",
						provenance: "model",
						verified: true,
						producer: { stepId: "run-tests", workflow: "enforcement-test" },
						artifact: { id: "tests", version: "1" },
					},
				],
			}),
		});
		const ctx = context(node.name, {});
		installPolicyExecution(ctx, policy(new InMemoryAuditSink()));

		await expect(new Runner([node]).run(ctx)).rejects.toThrow(/EVIDENCE_UNTRUSTED_OUTPUT/);
		expect(ctx.state?.evidence).toBeUndefined();
	});

	it("rejects a failed assertion before publication", async () => {
		const node = defineNode({
			name: "assert",
			description: "deterministic assertion",
			input: z.object({}),
			output: z.object({ passed: z.boolean() }),
			capabilityManifest: trustedManifest,
			outputTrust: "trusted",
			assertionGate: { version: "1", path: "passed", equals: true },
			execute: async () => ({ passed: false }),
		});
		const ctx = context(node.name, {});
		installPolicyExecution(ctx, policy(new InMemoryAuditSink()));

		await expect(new Runner([node]).run(ctx)).rejects.toThrow(/ASSERTION_FAILED/);
		expect(ctx.state?.assert).toBeUndefined();
	});

	it("accepts only deterministic trusted evidence", async () => {
		const node = defineNode({
			name: "evidence",
			description: "deterministic evidence verifier",
			input: z.object({}),
			output: z.object({ evidence: z.array(z.unknown()) }),
			capabilityManifest: trustedManifest,
			outputTrust: "trusted",
			evidenceGate: {
				version: "1",
				requirements: [{ artifactId: "tests", artifactVersion: "1", producerStepId: "run-tests" }],
			},
			execute: async () => ({
				evidence: [
					{
						version: "1",
						provenance: "trusted",
						verified: true,
						producer: { stepId: "run-tests", workflow: "enforcement-test" },
						artifact: { id: "tests", version: "1" },
					},
				],
			}),
		});
		const ctx = context(node.name, {});
		installPolicyExecution(ctx, policy(new InMemoryAuditSink()));

		await new Runner([node]).run(ctx, { deep: true });

		expect(ctx.state?.evidence).toBeDefined();
	});

	it("hands explicit approval metadata to the durable H1-01 interaction port", async () => {
		const store = new InMemoryInteractionStore();
		const node = defineNode({
			name: "deploy",
			description: "approved action",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: agentManifest,
			approval: { version: "1", reason: "Deploy the reviewed change", scope: "production" },
			execute: async () => ({ ok: true }),
		});
		const ctx = context(node.name, {});
		installPolicyExecution(ctx, {
			...policy(new InMemoryAuditSink(), {
				decision: { kind: "ask", id: "approval-1", reasonCode: "approval", policyVersion: "test-v1" },
				matchedRules: [],
			}),
			interaction: new DurableInteractionPort(store),
		});

		let interactionId = "";
		try {
			await new Runner([node]).run(ctx);
		} catch (error) {
			expect(error).toBeInstanceOf(PolicyInteractionRequiredError);
			interactionId = (error as PolicyInteractionRequiredError).requestId;
		}

		const record = await store.get(interactionId);
		expect(record?.request.approval).toEqual({
			version: "1",
			reason: "Deploy the reviewed change",
			scope: "production",
		});
	});

	it("rejects trusted output declarations without a deterministic manifest", async () => {
		const node = defineNode({
			name: "bad-trust",
			description: "not deterministic",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: agentManifest,
			outputTrust: "trusted",
			execute: async () => ({ ok: true }),
		});
		const ctx = context(node.name, {});
		installPolicyExecution(ctx, policy(new InMemoryAuditSink()));

		await expect(new Runner([node]).run(ctx)).rejects.toThrow(/TRUSTED_OUTPUT_INVALID/);
		expect(ctx.state?.[node.name]).toBeUndefined();
	});

	it("revalidates cached model output before replay publication", async () => {
		let calls = 0;
		const node = defineNode({
			name: "cached-agent",
			description: "cached model step",
			input: z.object({}),
			output: z.object({ completed: z.boolean() }),
			capabilityManifest: agentManifest,
			agentStep: { version: "1", objective: "inspect", completion: { path: "completed" } },
			execute: async () => {
				calls += 1;
				return { completed: true };
			},
		});
		node.idempotencyKey = "cache-key";
		const ctx = context(node.name, {});
		installPolicyExecution(ctx, policy(new InMemoryAuditSink()));
		const tracker = RunTracker.getInstance();
		const run = tracker.startRun({
			workflowName: "enforcement-test",
			workflowPath: "<test>",
			triggerType: "test",
			triggerSummary: {},
			nodeCount: 1,
		});
		(ctx as Record<string, unknown>)._traceRunId = run.id;
		tracker.getStore().setIdempotencyCache("enforcement-test", node.name, "cache-key", {
			data: { success: true, data: { completed: false }, error: null },
			cachedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			sourceRunId: "source-run",
			sourceNodeRunId: "source-node",
		});

		await expect(new Runner([node]).run(ctx)).rejects.toThrow(/AGENT_STEP_INCOMPLETE/);
		expect(calls).toBe(0);
		expect(ctx.state?.[node.name]).toBeUndefined();
	});
});
