/**
 * Regression for the OBS-03 crash: `TracingLogger` is constructed on EVERY
 * trigger run (TriggerBase wraps the logger to forward logs to RunTracker),
 * so reading the active span for trace correlation must never throw. The
 * SSE/WebSocket/MCP trigger tests mock `@opentelemetry/api` with only
 * `getTracer` — when the OBS-03 change started calling `trace.getActiveSpan()`
 * + `isSpanContextValid()` in the constructor, those partial mocks made it
 * throw `getActiveSpan is not a function`, which crashed the request handler
 * (empty SSE streams, WS/MCP timeouts). The constructor now swallows the
 * failure and simply omits the trace ids.
 */

import type { LoggerContext } from "@blokjs/shared";
import { describe, expect, it, vi } from "vitest";

// Partial @opentelemetry/api surface — mirrors the trigger test mocks that
// only stub `getTracer`. `getActiveSpan` and `isSpanContextValid` are absent,
// so any unguarded call to them throws a TypeError at construction.
vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_n: string, fn: (s: unknown) => unknown) =>
				fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

import type { RunTracker } from "../../src/tracing/RunTracker";
import { TracingLogger } from "../../src/tracing/TracingLogger";

function mockInner() {
	return {
		log: vi.fn(),
		logLevel: vi.fn(),
		error: vi.fn(),
		getLogs: vi.fn(() => []),
		getLogsAsText: vi.fn(() => ""),
		getLogsAsBase64: vi.fn(() => ""),
		setRunId: vi.fn(),
		setTraceContext: vi.fn(),
	};
}
const mockTracker = { active: false, addLog: vi.fn() } as unknown as RunTracker;

describe("TracingLogger — partial @opentelemetry/api surface (OBS-03 regression)", () => {
	it("does not throw at construction when trace.getActiveSpan is missing", () => {
		const inner = mockInner();
		expect(() => new TracingLogger(inner as unknown as LoggerContext, "run_xyz", mockTracker)).not.toThrow();
	});

	it("still stamps the run id even when trace context is unavailable", () => {
		const inner = mockInner();
		new TracingLogger(inner as unknown as LoggerContext, "run_xyz", mockTracker);
		expect(inner.setRunId).toHaveBeenCalledWith("run_xyz");
		// No usable span context → trace ids are simply omitted, not stamped.
		expect(inner.setTraceContext).not.toHaveBeenCalled();
	});

	it("still forwards log calls to the inner logger", () => {
		const inner = mockInner();
		const tl = new TracingLogger(inner as unknown as LoggerContext, "run_xyz", mockTracker);
		tl.log("hi");
		expect(inner.log).toHaveBeenCalledWith("hi");
	});
});
