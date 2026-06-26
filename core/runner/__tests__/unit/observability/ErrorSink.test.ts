import { afterEach, describe, expect, it, vi } from "vitest";
import { captureError, getErrorSink, setErrorSink } from "../../../src/observability/ErrorSink";
import { createSentryErrorSink } from "../../../src/observability/SentryIntegration";

describe("ErrorSink (MO-ALERTS)", () => {
	afterEach(() => setErrorSink(null));

	it("captureError is a no-op when no sink is installed", () => {
		setErrorSink(null);
		expect(getErrorSink()).toBeNull();
		expect(() => captureError(new Error("x"))).not.toThrow();
	});

	it("forwards the error + context to the installed sink", () => {
		const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];
		setErrorSink({ captureException: (error, context) => captured.push({ error, context }), flush: async () => true });
		const err = new Error("boom");
		captureError(err, { source: "test" });
		expect(captured).toEqual([{ error: err, context: { source: "test" } }]);
	});

	it("NEVER throws even if the sink itself throws (reporting must not crash the app)", () => {
		setErrorSink({
			captureException: () => {
				throw new Error("sink broke");
			},
			flush: async () => true,
		});
		expect(() => captureError(new Error("x"))).not.toThrow();
	});

	it("createSentryErrorSink stays inert (no throw) when @sentry/node is absent", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sink = createSentryErrorSink("https://key@example.test/1");
		// @sentry/node isn't a runner dependency, so the sink is inert — capturing must not throw.
		expect(() => sink.captureException(new Error("x"), { a: 1 })).not.toThrow();
		warn.mockRestore();
	});
});
