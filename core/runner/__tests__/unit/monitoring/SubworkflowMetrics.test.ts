import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubworkflowMetrics } from "../../../src/monitoring/SubworkflowMetrics";

describe("SubworkflowMetrics (OBS-05 T5 · async sub-workflow failure counter)", () => {
	beforeEach(() => {
		SubworkflowMetrics.resetInstance();
	});

	afterEach(() => {
		SubworkflowMetrics.resetInstance();
	});

	it("getInstance returns a singleton", () => {
		expect(SubworkflowMetrics.getInstance()).toBe(SubworkflowMetrics.getInstance());
	});

	it("recordAsyncFailure does not throw without an OTel exporter (both dispatch labels)", () => {
		const m = SubworkflowMetrics.getInstance();
		expect(() => m.recordAsyncFailure({ workflow_name: "wf", dispatch: "in-process" })).not.toThrow();
		expect(() => m.recordAsyncFailure({ workflow_name: "wf", dispatch: "http-self" })).not.toThrow();
	});
});
