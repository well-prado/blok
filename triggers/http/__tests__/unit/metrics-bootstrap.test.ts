/**
 * MO-METRICS — the metrics opt-out gate at the source. Tests the REAL
 * `bootstrapMetrics()` (no mock): disabled → null + nothing built; enabled →
 * exporter + handler. Importing the module must have NO side-effect (the
 * provider is installed only by an explicit bootstrap call).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapMetrics, resetBootstrap } from "../../src/runner/metrics/opentelemetry_metrics";

// `delete` is the only way to truly UNSET an env var — `= undefined` stores the
// string "undefined". (biome's noDelete is a perf rule; irrelevant here.)
function setDisabled(v: string | undefined): void {
	if (v === undefined) {
		// biome-ignore lint/performance/noDelete: must unset, not set the string "undefined"
		delete process.env.BLOK_METRICS_DISABLED;
	} else {
		process.env.BLOK_METRICS_DISABLED = v;
	}
}

describe("metrics opt-out gate — bootstrapMetrics()", () => {
	const orig = process.env.BLOK_METRICS_DISABLED;
	beforeEach(() => resetBootstrap());
	afterEach(() => {
		resetBootstrap();
		setDisabled(orig);
	});

	it("returns null + builds no exporter/provider when BLOK_METRICS_DISABLED=1", async () => {
		process.env.BLOK_METRICS_DISABLED = "1";
		expect(await bootstrapMetrics()).toBeNull();
	});

	it("is idempotent when disabled (null both times)", async () => {
		process.env.BLOK_METRICS_DISABLED = "1";
		expect(await bootstrapMetrics()).toBeNull();
		expect(await bootstrapMetrics()).toBeNull();
	});

	it("builds the exporter + returns a handler when enabled, and is idempotent", async () => {
		setDisabled(undefined);
		const a = await bootstrapMetrics();
		expect(a).not.toBeNull();
		expect(typeof a?.metricsHandler).toBe("function");
		expect(a?.meter).toBeDefined();
		// Repeated calls return the same result — no second provider/server.
		expect(await bootstrapMetrics()).toBe(a);
	});
});
