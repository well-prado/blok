import { describe, expect, it } from "vitest";
import {
	compareWorkflowContract,
	evaluateEnforcementProfile,
	explainWorkflowBinding,
	pinWorkflowRunContract,
	resolveWorkflowBinding,
	workflowBindingFingerprint,
} from "../../policy/WorkflowBinding";
import type { WorkflowBindingCatalog, WorkflowReference } from "../../policy/WorkflowBinding";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const source: WorkflowReference = {
	name: "understand-plan-implement",
	version: "3.2.0",
	source: { kind: "registry", id: "trusted-understand-v1", digest: digest("a"), trusted: true },
	irDigest: digest("b"),
};

const catalog: WorkflowBindingCatalog = {
	workflows: [source],
	rules: [
		{ version: "1", id: "default", priority: 0, selector: {}, workflow: source, profile: "advisory" },
		{
			version: "1",
			id: "repo-strict",
			priority: 10,
			selector: { repository: { provider: "github", id: "well/blok" }, labels: ["coding"] },
			workflow: source,
			profile: "strict",
		},
	],
};

const inputs = { repository: { provider: "github", id: "well/blok" }, labels: ["coding"], taskType: "implement" };

describe("workflow binding resolver", () => {
	it("selects by priority then specificity and emits stable explanations", () => {
		const first = resolveWorkflowBinding({ inputs, catalog });
		const second = resolveWorkflowBinding({
			inputs: { labels: ["coding"], repository: inputs.repository, taskType: "implement" },
			catalog: { rules: [...catalog.rules].reverse(), workflows: [...(catalog.workflows ?? [])].reverse() },
		});

		expect(first.status).toBe("resolved");
		expect(first.profile).toBe("strict");
		expect(first.explanation.matchedRuleIds).toEqual(["default", "repo-strict"]);
		expect(explainWorkflowBinding(first)).toBe(explainWorkflowBinding(second));
		expect(workflowBindingFingerprint(first)).toBe(workflowBindingFingerprint(second));
	});

	it("fails closed when equal-precedence strict rules conflict", () => {
		const result = resolveWorkflowBinding({
			inputs,
			catalog: {
				rules: [
					{ ...catalog.rules[1], id: "strict-a", workflow: { ...source, name: "workflow-a" } },
					{ ...catalog.rules[1], id: "strict-b", workflow: { ...source, name: "workflow-b" } },
				],
			},
		});

		expect(result.status).toBe("denied");
		expect(result.explanation.reasonCode).toBe("strict-binding-ambiguous");
		expect(result.explanation.winningRuleIds).toEqual(["strict-a", "strict-b"]);
	});

	it("rejects untrusted, missing, and changed workflow identities", () => {
		const untrustedSource = { ...source, source: { ...source.source, trusted: false } } as unknown as WorkflowReference;
		const untrusted = resolveWorkflowBinding({
			inputs,
			catalog: { rules: [{ ...catalog.rules[1], workflow: untrustedSource }] },
		});
		expect(untrusted.status).toBe("denied");
		expect(untrusted.explanation.reasonCode).toBe("binding-source-untrusted");

		const missing = resolveWorkflowBinding({ inputs, catalog: { rules: [catalog.rules[1]], workflows: [] } });
		expect(missing.explanation.reasonCode).toBe("binding-source-missing");

		const changedVersion = resolveWorkflowBinding({
			inputs,
			catalog: { rules: [catalog.rules[1]], workflows: [{ ...source, version: "4.0.0" }] },
		});
		expect(changedVersion.explanation.reasonCode).toBe("binding-source-version-unavailable");
	});

	it("keeps unmatched tasks advisory and enforces profile semantics", () => {
		const result = resolveWorkflowBinding({
			inputs: { repository: { provider: "github", id: "other/repo" } },
			catalog: { rules: [catalog.rules[1]], workflows: [source] },
		});
		expect(result.status).toBe("unbound");
		expect(result.profile).toBe("advisory");
		expect(evaluateEnforcementProfile("advisory", { deviation: true })).toMatchObject({
			allowed: true,
			recorded: true,
		});
		expect(evaluateEnforcementProfile("guided", { deviation: true }).reasonCode).toBe("guided-override-required");
		expect(
			evaluateEnforcementProfile("guided", {
				deviation: true,
				authorizedOverride: true,
				reason: "incident response",
				scope: "tests only",
			}),
		).toMatchObject({ allowed: true, reasonCode: "guided-override" });
		expect(evaluateEnforcementProfile("strict", { deviation: true, authorizedOverride: true })).toMatchObject({
			allowed: false,
			reasonCode: "strict-bypass-denied",
		});
	});

	it("pins and detects deletion, version, source, and contract changes", () => {
		const resolved = resolveWorkflowBinding({ inputs, catalog });
		const contract = pinWorkflowRunContract(resolved, {
			runId: "run-1",
			boundAt: "2026-09-01T12:00:00.000Z",
			nodes: [{ id: "workspace.read", version: "1.0.0", digest: digest("c") }],
			runtimes: [{ kind: "nodejs", version: "22.1.0" }],
			capabilityManifest: { version: "1", digest: digest("d") },
			policy: { id: "agent-policy", version: "3.0.0", digest: digest("e") },
			model: { provider: "openai", id: "agent-model", version: "1", configDigest: digest("f") },
		});
		const current = {
			workflow: source,
			nodes: contract.nodes,
			runtimes: contract.runtimes,
			capabilityManifest: contract.capabilityManifest,
			policy: contract.policy,
			model: contract.model,
		};
		expect(Object.isFrozen(contract)).toBe(true);
		expect(compareWorkflowContract(contract, current).status).toBe("current");
		expect(compareWorkflowContract(contract, undefined).status).toBe("workflow-deleted");
		expect(compareWorkflowContract(contract, { ...current, workflow: { ...source, version: "4.0.0" } }).status).toBe(
			"workflow-version-changed",
		);
		expect(
			compareWorkflowContract(contract, { ...current, workflow: { ...source, irDigest: digest("g") } }).status,
		).toBe("workflow-source-changed");
		expect(
			compareWorkflowContract(contract, { ...current, policy: { ...current.policy, version: "4.0.0" } }).status,
		).toBe("workflow-contract-changed");
	});
});
