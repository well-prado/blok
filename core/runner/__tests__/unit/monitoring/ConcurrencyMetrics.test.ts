import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ConcurrencyMetrics,
	filterPerKeyAttrs,
	isPerKeyMetricsEnabled,
} from "../../../src/monitoring/ConcurrencyMetrics";

describe("ConcurrencyMetrics (Tier 2 follow-up · OTel counters)", () => {
	const ORIGINAL_PER_KEY = process.env.BLOK_METRICS_PER_KEY;

	beforeEach(() => {
		ConcurrencyMetrics.resetInstance();
		// Always start from a known-off baseline so a stray env var in CI
		// doesn't bleed into the case under test. `delete` is the only way
		// to make the env-var read return `undefined` from the process side,
		// so the biome "no-delete" rule is suppressed for these helpers.
		// biome-ignore lint/performance/noDelete: env-var reset must reach `undefined`, not `""`.
		delete process.env.BLOK_METRICS_PER_KEY;
	});

	afterEach(() => {
		ConcurrencyMetrics.resetInstance();
		if (ORIGINAL_PER_KEY === undefined) {
			// biome-ignore lint/performance/noDelete: same env-var reset rationale as beforeEach.
			delete process.env.BLOK_METRICS_PER_KEY;
		} else {
			process.env.BLOK_METRICS_PER_KEY = ORIGINAL_PER_KEY;
		}
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

	// PR 3 D1 — backend install counter.
	it("recordBackendInstall does not throw and accepts both labels", () => {
		const m = ConcurrencyMetrics.getInstance();
		expect(() => m.recordBackendInstall({ backend: "nats-kv", status: "success" })).not.toThrow();
		expect(() => m.recordBackendInstall({ backend: "nats-kv", status: "failure" })).not.toThrow();
		expect(() => m.recordBackendInstall({ backend: "unknown", status: "failure" })).not.toThrow();
	});

	// PR 3 D2 — OCC retry histogram.
	it("recordOccRetries does not throw and accepts all three outcomes", () => {
		const m = ConcurrencyMetrics.getInstance();
		expect(() =>
			m.recordOccRetries({ workflow_name: "wf", concurrency_key: "k", outcome: "success" }, 0),
		).not.toThrow();
		expect(() => m.recordOccRetries({ workflow_name: "wf", concurrency_key: "k", outcome: "denied" }, 2)).not.toThrow();
		expect(() =>
			m.recordOccRetries({ workflow_name: "wf", concurrency_key: "k", outcome: "fail-closed" }, 10),
		).not.toThrow();
	});

	it("attrs without optional concurrency_key are accepted", () => {
		const m = ConcurrencyMetrics.getInstance();
		expect(() => m.recordAcquired({ workflow_name: "wf" })).not.toThrow();
	});
});

// D6 (v0.6) — per-key emission opt-in. Default behavior strips
// `concurrency_key` so any non-trivial deployment doesn't accidentally
// blow up its metrics cardinality by tagging every per-tenant /
// per-user key as a label. Opt in to per-key granularity with
// `BLOK_METRICS_PER_KEY=1`.
describe("ConcurrencyMetrics — BLOK_METRICS_PER_KEY (D6)", () => {
	const ORIGINAL_PER_KEY = process.env.BLOK_METRICS_PER_KEY;

	beforeEach(() => {
		ConcurrencyMetrics.resetInstance();
		// biome-ignore lint/performance/noDelete: env-var reset must reach `undefined`, not `""`.
		delete process.env.BLOK_METRICS_PER_KEY;
	});

	afterEach(() => {
		ConcurrencyMetrics.resetInstance();
		if (ORIGINAL_PER_KEY === undefined) {
			// biome-ignore lint/performance/noDelete: env-var reset must reach `undefined`, not `""`.
			delete process.env.BLOK_METRICS_PER_KEY;
		} else {
			process.env.BLOK_METRICS_PER_KEY = ORIGINAL_PER_KEY;
		}
	});

	it("isPerKeyMetricsEnabled returns false by default (env var unset)", () => {
		expect(isPerKeyMetricsEnabled()).toBe(false);
	});

	it("isPerKeyMetricsEnabled returns true when BLOK_METRICS_PER_KEY=1", () => {
		process.env.BLOK_METRICS_PER_KEY = "1";
		expect(isPerKeyMetricsEnabled()).toBe(true);
	});

	it("isPerKeyMetricsEnabled returns true when BLOK_METRICS_PER_KEY=true", () => {
		process.env.BLOK_METRICS_PER_KEY = "true";
		expect(isPerKeyMetricsEnabled()).toBe(true);
	});

	it("isPerKeyMetricsEnabled returns false for unrecognized values (no surprise opt-in)", () => {
		process.env.BLOK_METRICS_PER_KEY = "yes";
		expect(isPerKeyMetricsEnabled()).toBe(false);
		process.env.BLOK_METRICS_PER_KEY = "0";
		expect(isPerKeyMetricsEnabled()).toBe(false);
		process.env.BLOK_METRICS_PER_KEY = "";
		expect(isPerKeyMetricsEnabled()).toBe(false);
	});

	it("filterPerKeyAttrs strips concurrency_key when disabled", () => {
		const filtered = filterPerKeyAttrs({ workflow_name: "wf", concurrency_key: "user-42" }, false);
		expect(filtered.workflow_name).toBe("wf");
		expect(filtered.concurrency_key).toBeUndefined();
	});

	it("filterPerKeyAttrs preserves concurrency_key when enabled", () => {
		const input = { workflow_name: "wf", concurrency_key: "user-42" };
		const filtered = filterPerKeyAttrs(input, true);
		// Same reference — no allocation on the hot path when the flag is on.
		expect(filtered).toBe(input);
		expect(filtered.concurrency_key).toBe("user-42");
	});

	it("filterPerKeyAttrs is a no-op when concurrency_key is already undefined", () => {
		const input = { workflow_name: "wf" };
		const filtered = filterPerKeyAttrs(input, false);
		// Same reference — `delete`-via-destructure would allocate
		// unnecessarily for the common no-key case.
		expect(filtered).toBe(input);
	});

	it("filterPerKeyAttrs preserves sibling fields (mode, outcome) when stripping concurrency_key", () => {
		const filtered = filterPerKeyAttrs(
			{ workflow_name: "wf", concurrency_key: "k", mode: "throw" as const, outcome: "success" as const },
			false,
		);
		expect(filtered.workflow_name).toBe("wf");
		expect(filtered.concurrency_key).toBeUndefined();
		expect(filtered.mode).toBe("throw");
		expect(filtered.outcome).toBe("success");
	});

	it("ConcurrencyMetrics singleton captures the env var at construction time", () => {
		process.env.BLOK_METRICS_PER_KEY = "1";
		const enabledInstance = ConcurrencyMetrics.getInstance();
		// Smoke — does not throw, env-var captured.
		expect(() => enabledInstance.recordAcquired({ workflow_name: "wf", concurrency_key: "k" })).not.toThrow();

		// Flipping the env AFTER getInstance() doesn't take effect — captured.
		// biome-ignore lint/performance/noDelete: env-var reset must reach `undefined`, not `""`.
		delete process.env.BLOK_METRICS_PER_KEY;
		expect(() => enabledInstance.recordAcquired({ workflow_name: "wf", concurrency_key: "k" })).not.toThrow();

		// resetInstance + re-getInstance picks up the new env value.
		ConcurrencyMetrics.resetInstance();
		const disabledInstance = ConcurrencyMetrics.getInstance();
		expect(() => disabledInstance.recordAcquired({ workflow_name: "wf", concurrency_key: "k" })).not.toThrow();
	});
});
