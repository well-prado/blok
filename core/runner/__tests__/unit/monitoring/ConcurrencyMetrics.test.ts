import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConcurrencyMetrics } from "../../../src/monitoring/ConcurrencyMetrics";

describe("ConcurrencyMetrics (Tier 2 follow-up · OTel counters)", () => {
	beforeEach(() => {
		ConcurrencyMetrics.resetInstance();
	});

	afterEach(() => {
		ConcurrencyMetrics.resetInstance();
	});

	it("getInstance returns a singleton", () => {
		const a = ConcurrencyMetrics.getInstance();
		const b = ConcurrencyMetrics.getInstance();
		expect(a).toBe(b);
	});

	it("recordAcquired / recordDenied / recordReleased do not throw without an OTel exporter", () => {
		const m = ConcurrencyMetrics.getInstance();
		expect(() => m.recordAcquired({ workflow_name: "wf", concurrency_key: "k" })).not.toThrow();
		expect(() => m.recordDenied({ workflow_name: "wf", concurrency_key: "k", mode: "throw" })).not.toThrow();
		expect(() => m.recordDenied({ workflow_name: "wf", concurrency_key: "k", mode: "queue" })).not.toThrow();
		expect(() => m.recordReleased({ workflow_name: "wf", concurrency_key: "k" })).not.toThrow();
	});

	it("scheduling counters do not throw without an OTel exporter", () => {
		const m = ConcurrencyMetrics.getInstance();
		expect(() =>
			m.recordDispatchRecovered({
				workflow_name: "wf",
				trigger_type: "http",
				dispatch_status: "delayed",
			}),
		).not.toThrow();
		expect(() =>
			m.recordDispatchExpired({
				workflow_name: "wf",
				trigger_type: "http",
				dispatch_status: "delayed",
			}),
		).not.toThrow();
		expect(() =>
			m.recordDispatchFired({
				workflow_name: "wf",
				trigger_type: "http",
				dispatch_status: "delayed",
			}),
		).not.toThrow();
	});

	it("attrs without optional concurrency_key are accepted", () => {
		const m = ConcurrencyMetrics.getInstance();
		expect(() => m.recordAcquired({ workflow_name: "wf" })).not.toThrow();
	});
});
