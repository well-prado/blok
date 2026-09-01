import { describe, expect, it } from "vitest";
import {
	WorkflowBindingContractError,
	parseEnforcementOverrideEvent,
	parsePinnedWorkflowRunContract,
	parseWorkflowBindingInputs,
	parseWorkflowBindingRule,
	parseWorkflowBindingRules,
	serializeWorkflowBindingInputs,
} from "../../src/WorkflowBindingContracts";

const digest = `sha256:${"a".repeat(64)}`;

const validRule = {
	version: "1",
	id: "strict-coding",
	priority: 100,
	selector: {
		taskTypes: ["implement"],
		labels: ["security", "coding"],
		paths: ["src/", "core/"],
		environments: ["production"],
	},
	workflow: {
		name: "coding-harness",
		version: "2.1.0",
		source: { kind: "registry", id: "org/coding-harness", digest, trusted: true },
		irDigest: digest,
	},
	profile: "strict",
} as const;

const validRunContract = {
	version: "1",
	runId: "run-42",
	profile: "strict",
	bindingRuleId: "strict-coding",
	boundAt: "2026-09-01T12:00:00.000Z",
	workflow: validRule.workflow,
	nodes: [
		{ id: "implement", version: "1.2.0" },
		{ id: "inspect", version: "1.0.0", digest },
	],
	runtimes: [{ kind: "nodejs", version: "22.14.0" }],
	capabilityManifest: { version: "1", digest },
	policy: { id: "production-policy", version: "2026-09-01", digest },
	model: { provider: "openai", id: "gpt-5.6", version: "1", configDigest: digest },
} as const;

const validOverride = {
	version: "1",
	eventType: "enforcement.override",
	eventId: "override-42",
	timestamp: "2026-09-01T12:01:00.000Z",
	runId: "run-42",
	profile: "guided",
	bindingRuleId: "guided-coding",
	requestedBy: { id: "agent-session-1", kind: "agent" },
	authorizedBy: { id: "alice", kind: "human" },
	authorization: {
		method: "durable-interaction",
		interactionId: "approval-42",
		decisionId: "decision-42",
		status: "answered",
	},
	reasonCode: "urgent-hotfix",
	scope: { transitionIds: ["test", "implement"], stepIds: ["implement"] },
} as const;

describe("workflow binding contracts", () => {
	it("canonicalizes binding facts for deterministic matching and serialization", () => {
		const inputs = {
			taskType: "implement",
			labels: ["zeta", "alpha", "alpha"],
			paths: ["src/z.ts", "src/a.ts", "src/z.ts"],
			attributes: { tenantTier: "gold", priority: 2 },
		};
		const parsed = parseWorkflowBindingInputs(inputs);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(parsed).toEqual({
			taskType: "implement",
			labels: ["alpha", "zeta"],
			paths: ["src/a.ts", "src/z.ts"],
			attributes: { priority: 2, tenantTier: "gold" },
		});
		expect(serializeWorkflowBindingInputs(inputs)).toBe(JSON.stringify(parsed));
		expect(
			serializeWorkflowBindingInputs({ ...inputs, labels: ["alpha", "zeta"], paths: ["src/a.ts", "src/z.ts"] }),
		).toBe(serializeWorkflowBindingInputs(inputs));
	});

	it("parses a strict rule only when its workflow source is trusted and hashed", () => {
		expect(parseWorkflowBindingRule({ ...validRule, futureField: true })).toMatchObject({
			id: "strict-coding",
			profile: "strict",
			workflow: { source: { trusted: true } },
		});
		expect(() =>
			parseWorkflowBindingRule({
				...validRule,
				workflow: { ...validRule.workflow, source: { ...validRule.workflow.source, trusted: false } },
			}),
		).toThrow(WorkflowBindingContractError);
		expect(() =>
			parseWorkflowBindingRule({
				...validRule,
				workflow: { ...validRule.workflow, irDigest: "workspace-file" },
			}),
		).toThrow("complete hexadecimal length");
		expect(
			parseWorkflowBindingRules([
				validRule,
				{ ...validRule, id: "advisory-fallback", priority: 10, profile: "advisory" },
			]),
		).toMatchObject([{ id: "strict-coding" }, { id: "advisory-fallback" }]);
		expect(() => parseWorkflowBindingRules([validRule, validRule])).toThrow("rule ids must be unique");
	});

	it("pins every identity required for a reproducible run", () => {
		expect(
			parsePinnedWorkflowRunContract({
				...validRunContract,
				nodes: [...validRunContract.nodes].reverse(),
				note: "ignored",
			}),
		).toEqual(validRunContract);
		expect(() =>
			parsePinnedWorkflowRunContract({
				...validRunContract,
				model: { ...validRunContract.model, configDigest: "not-a-digest" },
			}),
		).toThrow(WorkflowBindingContractError);
		expect(() =>
			parsePinnedWorkflowRunContract({
				...validRunContract,
				nodes: [...validRunContract.nodes, validRunContract.nodes[0]],
			}),
		).toThrow("node ids must be unique");
		expect(() =>
			parsePinnedWorkflowRunContract({ ...validRunContract, nodes: [{ id: "inspect", version: "1.0.0" }] }),
		).not.toThrow();
	});

	it("accepts only a bounded, durably authorized guided override", () => {
		const parsed = parseEnforcementOverrideEvent(validOverride);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(parsed.scope).toEqual({ stepIds: ["implement"], transitionIds: ["implement", "test"] });
		expect(() => parseEnforcementOverrideEvent({ ...validOverride, profile: "strict" })).toThrow(
			WorkflowBindingContractError,
		);
		expect(() =>
			parseEnforcementOverrideEvent({
				...validOverride,
				authorization: { ...validOverride.authorization, status: "pending" },
			}),
		).toThrow(WorkflowBindingContractError);
		expect(() => parseEnforcementOverrideEvent({ ...validOverride, scope: {} })).toThrow(
			"scope must name at least one",
		);
	});

	it("bounds untrusted selector data", () => {
		expect(() => parseWorkflowBindingInputs({ labels: Array.from({ length: 129 }, (_, i) => `label-${i}`) })).toThrow(
			WorkflowBindingContractError,
		);
		expect(() => parseWorkflowBindingInputs({ paths: ["\0unsafe"] })).toThrow(WorkflowBindingContractError);
		expect(() => parseWorkflowBindingInputs({ attributes: { tooDeep: { value: true } } })).toThrow(
			WorkflowBindingContractError,
		);
	});
});
