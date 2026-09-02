import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import {
	authorizeEnforcementOverride,
	consumeEnforcementOverride,
	getEnforcementBinding,
	installEnforcementBinding,
} from "../../enforcement/EnforcementProfile";
import { pinWorkflowRunContract, resolveWorkflowBinding } from "../../policy/WorkflowBinding";
import { InMemoryRunStore } from "../../tracing/InMemoryRunStore";
import { RunTracker } from "../../tracing/RunTracker";
import { SqliteRunStore } from "../../tracing/SqliteRunStore";

const digest = `sha256:${"a".repeat(64)}`;

function rule(id: string, profile: "advisory" | "guided" | "strict", priority: number, labels: string[] = []) {
	return {
		version: "1" as const,
		id,
		priority,
		selector: labels.length > 0 ? { labels } : {},
		workflow: {
			name: "bound-workflow",
			version: "1.0.0",
			source: { kind: "workspace" as const, id: "bound-workflow", digest, trusted: true as const },
			irDigest: digest,
		},
		profile,
	};
}

describe("H1-03 runner enforcement lifecycle", () => {
	it("resolves canonical rules by priority, specificity, and stable rule ID", () => {
		const result = resolveWorkflowBinding({
			inputs: { labels: ["security", "coding"] },
			catalog: { rules: [rule("fallback", "advisory", 10), rule("specific", "strict", 10, ["security"])] },
		});

		expect(result.status).toBe("resolved");
		expect(result.profile).toBe("strict");
		expect(result.rule?.id).toBe("specific");
		expect(result.explanation.matchedRuleIds).toEqual(["fallback", "specific"]);
		expect(result.explanation.winningRuleIds).toEqual(["specific"]);
	});

	it("fails closed for equal-precedence strict targets", () => {
		const result = resolveWorkflowBinding({
			inputs: { labels: ["coding"] },
			catalog: {
				rules: [
					rule("a", "strict", 10),
					{ ...rule("b", "strict", 10), workflow: { ...rule("b", "strict", 10).workflow, version: "2.0.0" } },
				],
			},
		});

		expect(result.status).toBe("denied");
		expect(result.explanation.reasonCode).toBe("strict-binding-ambiguous");
		expect(result.explanation.winningRuleIds).toEqual(["a", "b"]);
	});

	it("creates a canonical immutable run pin and preserves it in trace storage", () => {
		const binding = resolveWorkflowBinding({
			inputs: { labels: ["coding"] },
			catalog: { rules: [rule("guided", "guided", 1)] },
		});
		const contract = pinWorkflowRunContract(binding, {
			runId: "run-1",
			boundAt: "2026-09-01T12:00:00.000Z",
			nodes: [{ id: "workspace.write", version: "2.0.0" }],
			runtimes: [{ kind: "nodejs", version: "22.0.0" }],
			capabilityManifest: { version: "1", digest },
			policy: { id: "policy", version: "1" },
			model: {
				provider: "openai",
				id: "gpt-5.6",
				version: "1",
				configDigest: digest,
			},
		});

		expect(Object.isFrozen(contract)).toBe(true);
		const store = new InMemoryRunStore();
		const tracker = new RunTracker(undefined, store);
		const run = tracker.startRun({
			workflowName: "bound-workflow",
			workflowPath: "bound-workflow",
			triggerType: "test",
			triggerSummary: "test",
			nodeCount: 1,
			enforcement: contract,
		});

		expect(run.enforcement?.bindingRuleId).toBe("guided");
		store.updateRun(run.id, { enforcement: { ...contract, bindingRuleId: "mutated" } });
		expect(tracker.getRun(run.id)?.enforcement?.bindingRuleId).toBe("guided");
		tracker.recordEnforcementDeviation(run.id, {
			stepId: "implement",
			index: 0,
			reasonCode: "guided-override",
			message: "authorized test deviation",
			recordedAt: "2026-09-01T12:01:00.000Z",
		});
		expect(tracker.getRun(run.id)?.enforcementDeviations).toHaveLength(1);
		expect(store.getEvents(run.id).some((event) => event.type === "RUN_ENFORCEMENT_DEVIATION")).toBe(true);

		const sqlite = new SqliteRunStore(":memory:");
		sqlite.saveRun({ ...run, enforcement: contract });
		sqlite.updateRun(run.id, { enforcement: { ...contract, bindingRuleId: "mutated" } });
		expect(sqlite.getRun(run.id)?.enforcement?.bindingRuleId).toBe("guided");
		sqlite.close();
	});

	it("accepts only scoped guided override events and consumes each scope once", () => {
		const context = {} as Context;
		const binding = resolveWorkflowBinding({ inputs: {}, catalog: { rules: [rule("guided", "guided", 1)] } });
		installEnforcementBinding(context, binding);
		expect(getEnforcementBinding(context)?.profile).toBe("guided");
		const override = {
			version: "1" as const,
			eventType: "enforcement.override" as const,
			eventId: "override-1",
			timestamp: "2026-09-01T12:00:00.000Z",
			runId: "run-1",
			profile: "guided" as const,
			bindingRuleId: "guided",
			authorizedBy: { id: "operator", kind: "human" },
			authorization: {
				method: "durable-interaction" as const,
				interactionId: "ask-1",
				decisionId: "decision-1",
				status: "answered" as const,
			},
			reasonCode: "approved-test-deviation",
			scope: { stepIds: ["implement"] },
		};
		authorizeEnforcementOverride(context, override);
		expect(consumeEnforcementOverride(context, "implement")?.eventId).toBe("override-1");
		expect(consumeEnforcementOverride(context, "implement")).toBeUndefined();
	});
});
