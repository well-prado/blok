import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapTracing, resetTracingBootstrap } from "../../src/monitoring/TracingBootstrap";

/**
 * OBS-02 — before this work, `bootstrapTracing` returned `null` because the OTel
 * trace SDK wasn't installed, so every span in the runner ran against the no-op
 * provider and exported nowhere. These tests prove the SDK is now a real
 * dependency and that bootstrapping flips the global tracer from no-op to
 * recording (i.e. spans will actually export to the configured OTLP backend).
 */
describe("bootstrapTracing (OBS-02 — distributed tracing flows)", () => {
	afterEach(() => {
		resetTracingBootstrap();
		// Reset the global tracer provider back to no-op so tests don't leak.
		trace.disable();
	});

	it("before bootstrap, the global tracer is a no-op (spans don't record)", () => {
		const span = trace.getTracer("obs-test").startSpan("noop");
		expect(span.isRecording()).toBe(false);
		span.end();
	});

	it("installs a real TracerProvider so spans record — proves the OTLP SDK is installed", async () => {
		const result = await bootstrapTracing({ serviceName: "blok-test", exporter: "console" });

		// A `null` result means the SDK packages are missing — which is exactly
		// the bug OBS-02 fixes. Non-null proves they're installed + wired.
		expect(result).not.toBeNull();
		expect(typeof result?.shutdown).toBe("function");

		const span = trace.getTracer("obs-test").startSpan("real");
		expect(span.isRecording()).toBe(true);
		span.end();

		await result?.shutdown();
	});
});
