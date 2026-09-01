import type {
	EnforcementOverrideEvent,
	PinnedWorkflowRunContract,
	WorkflowBindingInputs,
	WorkflowBindingRule,
	WorkflowReference,
} from "@blokjs/shared";
import type { BindingResolutionInput, WorkflowBindingCatalog } from "../../src/policy/WorkflowBinding";

export const sourceDigest = `sha256:${"a".repeat(64)}`;
export const alternateDigest = `sha256:${"b".repeat(64)}`;

export const trustedWorkflow: WorkflowReference = {
	name: "coding-harness",
	version: "2.1.0",
	source: {
		kind: "registry",
		id: "registry:coding-harness",
		digest: sourceDigest,
		trusted: true,
	},
	irDigest: sourceDigest,
};

export const alternateWorkflow: WorkflowReference = {
	...trustedWorkflow,
	name: "alternate-harness",
	source: { ...trustedWorkflow.source, id: "registry:alternate-harness", digest: alternateDigest },
	irDigest: alternateDigest,
};

export const defaultRule: WorkflowBindingRule = {
	version: "1",
	id: "coding-default",
	priority: 10,
	selector: {},
	workflow: trustedWorkflow,
	profile: "advisory",
};

export const strictRepositoryRule: WorkflowBindingRule = {
	version: "1",
	id: "coding-production",
	priority: 100,
	selector: {
		repository: { provider: "github", id: "well-prado/blok" },
		taskTypes: ["implement"],
		labels: ["coding", "security"],
		paths: ["core/runner", "core/shared"],
		environments: ["production"],
	},
	workflow: trustedWorkflow,
	profile: "strict",
};

export const matchingInputs: WorkflowBindingInputs = {
	repository: { provider: "github", id: "well-prado/blok" },
	taskType: "implement",
	labels: ["security", "coding"],
	paths: ["docs/README.md", "core/runner/src/RunnerSteps.ts"],
	environment: "production",
};

export const precedenceCatalog: WorkflowBindingCatalog = {
	rules: [defaultRule, strictRepositoryRule],
	workflows: [trustedWorkflow],
};

export const precedenceCase: BindingResolutionInput = {
	inputs: matchingInputs,
	catalog: precedenceCatalog,
};

export const ambiguityRules: readonly WorkflowBindingRule[] = [
	{ ...strictRepositoryRule, id: "strict-coding-a" },
	{ ...strictRepositoryRule, id: "strict-coding-b", workflow: alternateWorkflow },
];

export const ambiguityCase: BindingResolutionInput = {
	inputs: matchingInputs,
	catalog: { rules: ambiguityRules, workflows: [trustedWorkflow, alternateWorkflow] },
};

export const makePinnedContract = (runId = "run-h1-03"): PinnedWorkflowRunContract => ({
	version: "1",
	runId,
	profile: "guided",
	bindingRuleId: "coding-guided",
	boundAt: "2026-09-01T12:00:00.000Z",
	workflow: trustedWorkflow,
	nodes: [
		{ id: "workspace.read", version: "1.4.0", digest: sourceDigest },
		{ id: "workspace.write", version: "2.0.0", digest: alternateDigest },
	],
	runtimes: [{ kind: "nodejs", version: "22.14.0" }],
	capabilityManifest: { version: "1", digest: sourceDigest },
	policy: { id: "agent-policy", version: "2026.09.01", digest: alternateDigest },
	model: {
		provider: "openai",
		id: "gpt-5.6",
		version: "2026-08-01",
		configDigest: sourceDigest,
	},
});

export const makeGuidedOverride = (runId = "run-h1-03"): EnforcementOverrideEvent => ({
	version: "1",
	eventType: "enforcement.override",
	eventId: "override-h1-03",
	timestamp: "2026-09-01T12:01:00.000Z",
	runId,
	profile: "guided",
	bindingRuleId: "coding-guided",
	authorizedBy: { id: "operator-1", kind: "human" },
	authorization: {
		method: "durable-interaction",
		interactionId: "interaction-h1-03",
		decisionId: "decision-h1-03",
		status: "answered",
	},
	reasonCode: "approved-test-deviation",
	reason: "authorized conformance deviation",
	scope: { stepIds: ["workspace.write"] },
});
