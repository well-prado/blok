import { parseEnforcementOverrideEvent, parsePinnedWorkflowRunContract } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { InMemoryRunStore } from "../../src/tracing/InMemoryRunStore";
import { RunTracker } from "../../src/tracing/RunTracker";
import { makeGuidedOverride, makePinnedContract } from "../fixtures/h1-03-binding";

describe("H1-03 enforcement lifecycle conformance", () => {
	it("pins the canonical run contract atomically and rejects later contract mutation", () => {
		const store = new InMemoryRunStore();
		const tracker = new RunTracker(undefined, store);
		const run = tracker.startRun({
			workflowName: "coding-harness",
			workflowPath: "coding-harness",
			triggerType: "test",
			triggerSummary: "H1-03 conformance",
			nodeCount: 2,
			enforcementFactory: (runId) => parsePinnedWorkflowRunContract(makePinnedContract(runId)),
		});

		expect(run.enforcement?.runId).toBe(run.id);
		expect(Object.isFrozen(run.enforcement)).toBe(true);
		const originalRuleId = run.enforcement?.bindingRuleId;
		store.updateRun(run.id, { enforcement: { ...run.enforcement!, bindingRuleId: "mutated" } });
		expect(tracker.getRun(run.id)?.enforcement?.bindingRuleId).toBe(originalRuleId);
	});

	it("persists advisory deviations and emits an immutable guided override event", () => {
		const store = new InMemoryRunStore();
		const tracker = new RunTracker(undefined, store);
		const run = tracker.startRun({
			workflowName: "coding-harness",
			workflowPath: "coding-harness",
			triggerType: "test",
			triggerSummary: "H1-03 conformance",
			nodeCount: 2,
			enforcement: parsePinnedWorkflowRunContract(makePinnedContract("run-h1-03")),
		});
		const override = parseEnforcementOverrideEvent(makeGuidedOverride(run.enforcement?.runId ?? run.id));

		tracker.recordEnforcementDeviation(run.id, {
			stepId: "workspace.write",
			index: 1,
			reasonCode: "advisory-recorded",
			message: "reference deviation",
			recordedAt: "2026-09-01T12:01:00.000Z",
		});
		tracker.recordEnforcementOverride(run.id, override);

		expect(tracker.getRun(run.id)?.enforcementDeviations).toHaveLength(1);
		expect(store.getEvents(run.id).some((event) => event.type === "RUN_ENFORCEMENT_DEVIATION")).toBe(true);
		expect(store.getEvents(run.id).some((event) => event.type === "RUN_ENFORCEMENT_OVERRIDE")).toBe(true);
		expect(Object.isFrozen(override)).toBe(true);
	});
});
