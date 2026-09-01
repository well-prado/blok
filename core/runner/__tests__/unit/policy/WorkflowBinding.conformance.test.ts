import { describe, expect, it } from "vitest";
import {
	InMemoryWorkflowBindingProvider,
	assertWorkflowContractCurrent,
	compareWorkflowContract,
	evaluateEnforcementProfile,
	explainWorkflowBinding,
	pinWorkflowRunContract,
	resolveWorkflowBinding,
	workflowBindingFingerprint,
} from "../../../src/policy/WorkflowBinding";
import {
	alternateDigest,
	ambiguityCase,
	defaultRule,
	makePinnedContract,
	matchingInputs,
	precedenceCatalog,
	strictRepositoryRule,
	trustedWorkflow,
} from "../../fixtures/h1-03-binding";

describe("H1-03 binding/profile conformance", () => {
	it("selects the strict rule by priority and keeps explanation deterministic", () => {
		const first = resolveWorkflowBinding({ inputs: matchingInputs, catalog: precedenceCatalog });
		const second = resolveWorkflowBinding({
			inputs: { ...matchingInputs, labels: [...(matchingInputs.labels ?? [])].reverse() },
			catalog: {
				rules: [...precedenceCatalog.rules].reverse(),
				workflows: [...(precedenceCatalog.workflows ?? [])].reverse(),
			},
		});

		expect(first.profile).toBe("strict");
		expect(first.rule?.id).toBe(strictRepositoryRule.id);
		expect(first.explanation.matchedRuleIds).toEqual(["coding-default", "coding-production"]);
		expect(explainWorkflowBinding(first)).toBe(explainWorkflowBinding(second));
		expect(workflowBindingFingerprint(first)).toBe(workflowBindingFingerprint(second));
	});

	it("fails closed on an equal-precedence strict ambiguity and explains all winners", () => {
		const result = resolveWorkflowBinding(ambiguityCase);
		expect(result.status).toBe("denied");
		expect(result.explanation.reasonCode).toBe("strict-binding-ambiguous");
		expect(result.explanation.winningRuleIds).toEqual(["strict-coding-a", "strict-coding-b"]);
	});

	it("keeps unmatched work advisory and applies each profile's deviation semantics", () => {
		const result = resolveWorkflowBinding({
			inputs: { repository: { provider: "github", id: "other/repository" }, taskType: "review" },
			catalog: { rules: [strictRepositoryRule], workflows: [trustedWorkflow] },
		});
		expect(result.profile).toBe("advisory");
		expect(result.explanation.matchedRuleIds).toEqual([]);
		expect(evaluateEnforcementProfile("advisory", { deviation: true })).toMatchObject({
			allowed: true,
			recorded: true,
			reasonCode: "advisory-recorded",
		});
		expect(evaluateEnforcementProfile("guided", { deviation: true }).reasonCode).toBe("guided-override-required");
		expect(
			evaluateEnforcementProfile("guided", {
				deviation: true,
				authorizedOverride: true,
				reason: "incident response",
				scope: "workspace.write",
			}),
		).toMatchObject({ allowed: true, recorded: true, reasonCode: "guided-override" });
		expect(evaluateEnforcementProfile("strict", { deviation: true, authorizedOverride: true })).toMatchObject({
			allowed: false,
			reasonCode: "strict-bypass-denied",
		});
	});

	it("pins every workflow, node, runtime, capability, policy, and model identity", () => {
		const binding = resolveWorkflowBinding({
			inputs: matchingInputs,
			catalog: {
				rules: [{ ...defaultRule, id: "coding-guided", profile: "guided", priority: 100 }],
				workflows: [trustedWorkflow],
			},
		});
		const fixture = makePinnedContract();
		const contract = pinWorkflowRunContract(binding, {
			runId: fixture.runId,
			boundAt: fixture.boundAt,
			nodes: fixture.nodes,
			runtimes: fixture.runtimes,
			capabilityManifest: fixture.capabilityManifest,
			policy: fixture.policy,
			model: fixture.model,
		});

		expect(contract).toMatchObject({
			version: "1",
			runId: "run-h1-03",
			profile: "guided",
			bindingRuleId: "coding-guided",
			workflow: trustedWorkflow,
		});
		expect(contract.nodes.map((node) => node.id)).toEqual(["workspace.read", "workspace.write"]);
		expect(contract.runtimes).toEqual([{ kind: "nodejs", version: "22.14.0" }]);
	});

	it("detects deletion, workflow version/source changes, and execution identity changes without mutating the pin", () => {
		const contract = makePinnedContract();
		const current = {
			workflow: trustedWorkflow,
			nodes: contract.nodes,
			runtimes: contract.runtimes,
			capabilityManifest: contract.capabilityManifest,
			policy: contract.policy,
			model: contract.model,
		};

		expect(compareWorkflowContract(contract, current)).toEqual({ status: "current", changedFields: [] });
		expect(compareWorkflowContract(contract, undefined).status).toBe("workflow-deleted");
		expect(
			compareWorkflowContract(contract, { ...current, workflow: { ...trustedWorkflow, version: "3.0.0" } }).status,
		).toBe("workflow-version-changed");
		expect(
			compareWorkflowContract(contract, {
				...current,
				workflow: { ...trustedWorkflow, irDigest: alternateDigest },
			}).status,
		).toBe("workflow-source-changed");
		expect(
			compareWorkflowContract(contract, { ...current, policy: { ...contract.policy, version: "2026.09.02" } }).status,
		).toBe("workflow-contract-changed");
		expect(() => assertWorkflowContractCurrent(contract, undefined)).toThrow(/workflow-deleted/);
		expect(contract.workflow.version).toBe("2.1.0");
	});

	it("provides a snapshotting provider for repeatable explainability checks", () => {
		const provider = new InMemoryWorkflowBindingProvider(precedenceCatalog);
		const first = provider.resolve(matchingInputs);
		const second = provider.resolve({ ...matchingInputs, labels: ["coding", "security"] });
		expect(provider.explain(matchingInputs)).toBe(explainWorkflowBinding(first));
		expect(workflowBindingFingerprint(first)).toBe(workflowBindingFingerprint(second));
	});
});
