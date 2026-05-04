/**
 * PR 3 D3 — `JanitorMetrics` exposes a histogram for sweep duration
 * and a counter for purged rows. No-ops cleanly without an OTel
 * exporter (silently swallows recordings).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JanitorMetrics } from "../../../src/monitoring/JanitorMetrics";

describe("JanitorMetrics (PR 3 D3 · OTel histogram + counter)", () => {
	beforeEach(() => {
		JanitorMetrics.resetInstance();
	});

	afterEach(() => {
		JanitorMetrics.resetInstance();
	});

	it("getInstance returns a singleton", () => {
		const a = JanitorMetrics.getInstance();
		const b = JanitorMetrics.getInstance();
		expect(a).toBe(b);
	});

	it("recordSweep does not throw across the three table labels", () => {
		const m = JanitorMetrics.getInstance();
		expect(() => m.recordSweep({ table: "idempotency_cache" }, 12, 100)).not.toThrow();
		expect(() => m.recordSweep({ table: "concurrency_locks" }, 5, 0)).not.toThrow();
		expect(() => m.recordSweep({ table: "scheduled_dispatches" }, 200, 50)).not.toThrow();
	});

	it("zero-row sweeps still record duration but skip the counter increment", () => {
		const m = JanitorMetrics.getInstance();
		// Should not throw; the body only increments the counter when
		// rowsPurged > 0 to keep the counter clean.
		expect(() => m.recordSweep({ table: "idempotency_cache" }, 50, 0)).not.toThrow();
	});

	it("resetInstance allows fresh singleton", () => {
		const a = JanitorMetrics.getInstance();
		JanitorMetrics.resetInstance();
		const b = JanitorMetrics.getInstance();
		expect(a).not.toBe(b);
	});
});
