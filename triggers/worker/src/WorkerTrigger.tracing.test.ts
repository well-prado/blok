/**
 * OBS-02 T4 — Worker trigger bootstraps OTel tracing at listen() when an OTLP
 * endpoint is configured (mirrors the shipped HTTP B1 path), and stays no-op
 * otherwise. A no-workflow trigger boots, flips the global tracer from no-op to
 * recording, and `stop()` flushes + restores it.
 */

import { resetTracingBootstrap } from "@blokjs/runner";
import { trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerTrigger } from "./WorkerTrigger";

// Minimal concrete trigger — no nodes/workflows, so listen() boots and returns
// without connecting any broker adapter.
class TestWorker extends WorkerTrigger {
	protected nodes = {};
	protected workflows = {};
}

const saved: Record<string, string | undefined> = {};
const ENVS = [
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"BLOK_TRACING_DISABLED",
	"BLOK_JANITOR_DISABLED",
	"BLOK_CRASH_AUTOFLIP_DISABLED",
	"BLOK_GRACEFUL_SHUTDOWN_DISABLED",
];

describe("WorkerTrigger — OBS-02 T4 tracing bootstrap", () => {
	beforeEach(() => {
		for (const k of ENVS) saved[k] = process.env[k];
		// Neutralize process-level side effects so the boot test stays isolated.
		process.env.BLOK_JANITOR_DISABLED = "1";
		process.env.BLOK_CRASH_AUTOFLIP_DISABLED = "1";
		process.env.BLOK_GRACEFUL_SHUTDOWN_DISABLED = "1";
		// Clear the tracing kill-switch so ambient BLOK_TRACING_DISABLED=1 can't
		// make the positive test a false negative.
		process.env.BLOK_TRACING_DISABLED = "";
		// Empty string reads as "unset" to maybeBootstrapTracing (it gates on a
		// truthy endpoint), so no inherited endpoint leaks into the no-op test.
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "";
	});

	afterEach(() => {
		resetTracingBootstrap();
		trace.disable();
		for (const k of ENVS) {
			if (saved[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = saved[k];
			}
		}
	});

	it("enables OTLP tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		const trigger = new TestWorker();
		await trigger.listen();

		const span = trace.getTracer("probe").startSpan("probe");
		expect(span.isRecording()).toBe(true);
		span.end();

		await trigger.stop();
	});

	it("stays no-op when no OTLP endpoint is configured", async () => {
		const trigger = new TestWorker();
		await trigger.listen();

		const span = trace.getTracer("probe").startSpan("probe");
		expect(span.isRecording()).toBe(false);
		span.end();

		await trigger.stop();
	});
});
