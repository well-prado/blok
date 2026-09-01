/**
 * H1-02 reference workflow conformance slice.
 *
 * The model phases are mocked through the typed testing surface. The runner
 * still executes the real deterministic test, assertion, evidence, and
 * completion gates. A second scenario boots the same workflow through
 * TriggerBase so approval is durably suspended and resumed through H1-01.
 */
import type { Context, NodeBase } from "@blokjs/core/runtime";
import {
	Configuration,
	DurableInteractionPort,
	InMemoryAuditSink,
	InMemoryInteractionStore,
	InMemoryPolicyProvider,
	type PolicyExecutionOptions,
	PolicyInteractionRequiredError,
	RunTracker,
	Runner,
	TriggerBase,
	installPolicyExecution,
} from "@blokjs/core/runtime";
import { runWorkflow } from "@blokjs/core/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	approvalGate,
	assertionGate,
	completionGate,
	evidenceGate,
	implementModel,
	planModel,
	reviewModel,
	default as strictCodingWorkflow,
	testCapability,
	understandModel,
} from "../examples/strict-coding-workflow";

const policyVersion = "h1-02-test-v1";
const principalId = "h1-02-principal";

function policyOptions(
	auditSink: InMemoryAuditSink,
	interaction?: DurableInteractionPort,
	decide: (stepId: string) => "allow" | "ask" = () => "allow",
	requests: PolicyExecutionRequest[] = [],
): PolicyExecutionOptions {
	return {
		principal: { id: principalId, kind: "test" },
		session: { id: "h1-02-session" },
		turn: { id: "h1-02-turn" },
		policyVersion,
		provider: new InMemoryPolicyProvider(async (request) => {
			requests.push({ stepId: request.step.id, capabilities: [...request.scope.capabilities] });
			const kind = decide(request.step.id);
			return {
				decision: {
					kind,
					id: `decision-${request.step.id}-${kind}`,
					reasonCode: kind === "ask" ? "human-approval" : "test-allow",
					policyVersion,
				},
				matchedRules: [{ layer: "workflow", ruleId: `h1-02-${kind}` }],
			};
		}),
		auditSink,
		...(interaction ? { interaction } : {}),
	};
}

interface PolicyExecutionRequest {
	readonly stepId: string;
	readonly capabilities: readonly string[];
}

const modelMocks = {
	[understandModel.name]: async () => ({
		phase: "understand" as const,
		objective: "update the greeting",
		observations: ["The greeting is defined in src/app.ts."],
		modelClaimedEvidence: { producer: "model", verification: "passed" },
	}),
	[planModel.name]: async () => ({
		phase: "plan" as const,
		planId: "plan-mocked-1",
		summary: "Update the greeting and verify it",
	}),
	[implementModel.name]: async () => ({
		phase: "implement" as const,
		artifact: { uri: "src/app.ts", version: "v1", digest: "sha256:good" },
		modelClaimedEvidence: { producer: "model", verification: "passed" },
	}),
	[reviewModel.name]: async () => ({
		phase: "review" as const,
		accepted: true as const,
		summary: "The verified change is ready.",
	}),
};

function allReferenceNodes(): readonly NodeBase[] {
	return [
		understandModel,
		planModel,
		approvalGate,
		implementModel,
		testCapability,
		assertionGate,
		evidenceGate,
		reviewModel,
		completionGate,
	] as readonly NodeBase[];
}

function nodeOptions(nodes: readonly NodeBase[]) {
	return {
		nodes: {
			getNode: (name: string): NodeBase | null => nodes.find((node) => node.name === name) ?? null,
		},
		workflows: {},
	} as unknown as Parameters<Configuration["init"]>[1];
}

class ReferenceTrigger extends TriggerBase {
	constructor(private readonly workflowRunner: Runner) {
		super();
	}

	async listen(): Promise<number> {
		return 0;
	}

	override getRunner(): Runner {
		return this.workflowRunner;
	}
}

function triggerContext(trigger: ReferenceTrigger, config: Configuration): Context {
	const ctx = trigger.createContext(undefined, "/harness/strict-coding", "h1-02-run", config);
	ctx.request.body = { objective: "update the greeting" } as Context["request"]["body"];
	return ctx;
}

async function bootReferenceWorkflow(): Promise<{ config: Configuration; trigger: ReferenceTrigger }> {
	const model = (await strictCodingWorkflow) as { _config: Record<string, unknown> };
	const config = new Configuration();
	await config.init("strict-coding-reference", nodeOptions(allReferenceNodes()), model._config);
	const trigger = new ReferenceTrigger(new Runner(config.steps));
	trigger.configuration = config;
	return { config, trigger };
}

describe("H1-02 strict coding reference workflow", () => {
	const originalTraceSetting = process.env.BLOK_TRACE_ENABLED;

	beforeEach(() => {
		process.env.BLOK_TRACE_ENABLED = "true";
		RunTracker.resetInstance();
	});

	afterAll(() => {
		RunTracker.resetInstance();
		if (originalTraceSetting === undefined) process.env.BLOK_TRACE_ENABLED = undefined;
		else process.env.BLOK_TRACE_ENABLED = originalTraceSetting;
	});

	it("mocks model output while real gates enforce trusted test evidence", async () => {
		const audit = new InMemoryAuditSink();
		const requests: PolicyExecutionRequest[] = [];
		const run = await runWorkflow(
			strictCodingWorkflow,
			{ objective: "update the greeting" },
			{
				mock: modelMocks,
				policy: policyOptions(audit, undefined, () => "allow", requests),
			},
		);

		expect(run.ok).toBe(true);
		expect(run.state("complete")).toEqual({
			phase: "complete",
			completed: true,
			evidenceProducer: "trusted-test",
		});
		expect(run.state("evidence")).toMatchObject({ verified: true, producer: "trusted-test", version: "v1" });
		expect(run.step("approve")?.executed).toBe(true);
		expect(requests.find((request) => request.stepId === "implement")?.capabilities).toEqual(["workspace.write"]);
		expect(audit.read().filter((event) => event.eventType === "policy.pre")).toHaveLength(9);
	});

	it("cannot turn a model evidence claim into trusted evidence", async () => {
		const audit = new InMemoryAuditSink();
		const run = await runWorkflow(
			strictCodingWorkflow,
			{ objective: "update the greeting" },
			{
				mock: {
					...modelMocks,
					[implementModel.name]: async () => ({
						phase: "implement" as const,
						artifact: { uri: "src/app.ts", version: "v1", digest: "sha256:bad" },
						modelClaimedEvidence: { producer: "model", verification: "passed" },
					}),
				},
				policy: policyOptions(audit),
			},
		);

		expect(run.ok).toBe(false);
		expect(run.state("test")).toMatchObject({ producer: "trusted-test", verification: "failed" });
		expect(run.state("assert")).toBeUndefined();
		expect(run.state("evidence")).toBeUndefined();
		expect(run.step("review")?.executed).toBe(false);
	});

	it("durably suspends approve and resumes the same run after the answer", async () => {
		const { config, trigger } = await bootReferenceWorkflow();
		const audit = new InMemoryAuditSink();
		const store = new InMemoryInteractionStore();
		let approvalEvaluations = 0;
		const policy = policyOptions(audit, new DurableInteractionPort(store), (stepId) => {
			if (stepId === "approve" && approvalEvaluations++ === 0) return "ask";
			return "allow";
		});
		const policyContext = triggerContext(trigger, config);
		// The reference nodes have deterministic model implementations, so this
		// path uses the real nodes while the harness test above swaps in mocks.
		installPolicyExecution(policyContext, policy);

		let suspension: PolicyInteractionRequiredError | undefined;
		try {
			await trigger.run(policyContext, config);
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(PolicyInteractionRequiredError);
			suspension = error as PolicyInteractionRequiredError;
		}

		expect(suspension).toBeDefined();
		expect((await store.get(suspension?.requestId ?? ""))?.status).toBe("pending");
		const suspendedRun = RunTracker.getInstance().getStore().getRuns({ workflow: config.name }).runs[0];
		expect(suspendedRun).toMatchObject({ status: "suspended", lastCompletedStepIndex: 1 });

		await store.answer({ id: suspension?.requestId ?? "", principalId, answer: { approved: true }, sequence: 0 });
		await trigger.resumeInteraction(policyContext, suspension?.requestId ?? "", config);

		expect(RunTracker.getInstance().getRun(suspendedRun?.id ?? "")?.status).toBe("completed");
		expect(policyContext.state).toMatchObject({ complete: { completed: true, evidenceProducer: "trusted-test" } });
	});
});
