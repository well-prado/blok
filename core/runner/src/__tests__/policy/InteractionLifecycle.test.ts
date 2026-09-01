import type { Context, PolicyEvaluationResult } from "@blokjs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import Runner from "../../Runner";
import TriggerBase from "../../TriggerBase";
import { defineNode } from "../../defineNode";
import {
	DurableInteractionPort,
	InMemoryInteractionStore,
	PolicyInteractionRequiredError,
	installPolicyExecution,
} from "../../index";
import { InMemoryAuditSink } from "../../policy/PolicyPipeline";
import { RunTracker } from "../../tracing/RunTracker";

const manifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: ["network"] as const,
	capabilities: ["network.test"] as const,
	secrets: [] as const,
	determinism: "external" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

class PolicyTrigger extends TriggerBase {
	constructor(private readonly runner: Runner) {
		super();
	}

	async listen(): Promise<number> {
		return 0;
	}

	override getRunner(): Runner {
		return this.runner;
	}
}

function result(kind: "allow" | "ask", id: string): PolicyEvaluationResult {
	return {
		decision: { kind, id, reasonCode: kind === "ask" ? "approval" : "allowed", policyVersion: "test-v1" },
		matchedRules: [{ layer: "deployment", ruleId: `${kind}-rule` }],
	};
}

function contextFor(nodes: readonly { name: string }[]): Context {
	const state: Record<string, unknown> = {};
	return {
		id: "request-1",
		workflow_name: "interaction-workflow",
		workflow_path: "<test>",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { success: true, data: null, error: null },
		error: { message: [] },
		logger: { log: () => undefined, logLevel: () => undefined } as Context["logger"],
		config: Object.fromEntries(nodes.map((node) => [node.name, { inputs: { value: "x" } }])),
		eventLogger: null,
		state,
		vars: state,
		_PRIVATE_: {},
	} as Context;
}

describe("policy interaction lifecycle", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	it("suspends a traced run after persistence and resumes at the saved cursor", async () => {
		let prepareCalls = 0;
		let effectCalls = 0;
		let evaluations = 0;
		const prepare = defineNode({
			name: "prepare",
			input: z.object({ value: z.string() }),
			output: z.object({ prepared: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => {
				prepareCalls += 1;
				return { prepared: true };
			},
		});
		const effect = defineNode({
			name: "effect",
			input: z.object({ value: z.string() }),
			output: z.object({ applied: z.boolean() }),
			capabilityManifest: manifest,
			agentStep: { version: "1", objective: "apply the approved change", completion: { path: "applied" } },
			execute: async () => {
				effectCalls += 1;
				return { applied: true };
			},
		});
		const trigger = new PolicyTrigger(new Runner([prepare, effect]));
		const ctx = contextFor([prepare, effect]);
		const interactionStore = new InMemoryInteractionStore();
		installPolicyExecution(ctx, {
			principal: { id: "principal-1", kind: "test" },
			session: { id: "session-1" },
			turn: { id: "turn-1" },
			policyVersion: "test-v1",
			provider: { evaluate: async () => result(evaluations++ === 1 ? "ask" : "allow", `decision-${evaluations}`) },
			auditSink: new InMemoryAuditSink(),
			interaction: new DurableInteractionPort(interactionStore),
		});

		let interactionError: PolicyInteractionRequiredError | undefined;
		try {
			await trigger.run(ctx);
		} catch (error) {
			expect(error).toBeInstanceOf(PolicyInteractionRequiredError);
			interactionError = error as PolicyInteractionRequiredError;
		}
		expect(interactionError).toBeDefined();
		expect(prepareCalls).toBe(1);
		expect(effectCalls).toBe(0);

		const tracker = RunTracker.getInstance();
		const run = tracker.getStore().getRuns({ workflow: "interaction-workflow" }).runs[0];
		expect(run).toMatchObject({ status: "suspended", lastCompletedStepIndex: 0 });
		const interaction = await interactionStore.get(interactionError?.requestId ?? "");
		expect(interaction).toMatchObject({
			status: "pending",
			suspension: {
				runId: run?.id,
				status: "suspended",
				cursor: { stepIndex: 1, lastCompletedStepIndex: 0, deep: false },
				trace: { workflow: { name: "interaction-workflow" } },
			},
		});

		await interactionStore.answer({
			id: interactionError?.requestId ?? "",
			principalId: "principal-1",
			answer: { approved: true },
			sequence: 0,
		});
		await trigger.resumeInteraction(ctx, interactionError?.requestId ?? "");

		expect(prepareCalls).toBe(1);
		expect(effectCalls).toBe(1);
		expect(tracker.getRun(run?.id ?? "")?.status).toBe("completed");
	});
});
