/**
 * Complete `@opentelemetry/api` test double for the HTTP trigger unit suites.
 *
 * Centralizes what was previously copy-pasted (and quietly drifting) across
 * every `HttpTrigger.*.test.ts`. The triggers exercise the OTel API surface
 * for spans, metrics, AND — since OBS-02 B2 — trace-context propagation:
 * `propagation.extract`/`inject`, `context.active`, `SpanKind`, and the
 * four-argument `startActiveSpan(name, options, context, callback)` overload.
 * A partial mock that omits any of these throws inside the request handler
 * (the same failure class as the OBS-03 `TracingLogger` regression), so keep
 * this in lockstep with the OTel API the triggers actually call.
 *
 * Used from a `vi.mock("@opentelemetry/api", () => …)` factory, which is
 * hoisted above imports — hence `require()` rather than a top-level import.
 */

const noopSpan = {
	setAttribute: () => {},
	setStatus: () => {},
	recordException: () => {},
	end: () => {},
};

export function makeOtelApiMock() {
	return {
		trace: {
			getTracer: () => ({
				// Handles BOTH startActiveSpan(name, fn) and the
				// startActiveSpan(name, options, context, fn) overload by
				// invoking whichever argument is actually the callback.
				startActiveSpan: (...args: unknown[]) => {
					const fn = args.find((a) => typeof a === "function") as ((span: typeof noopSpan) => unknown) | undefined;
					return fn?.(noopSpan);
				},
				startSpan: () => noopSpan,
			}),
			getActiveSpan: () => undefined,
			setSpan: (ctx: unknown) => ctx,
		},
		metrics: {
			getMeter: () => ({
				createCounter: () => ({ add: () => {} }),
				createHistogram: () => ({ record: () => {} }),
				createGauge: () => ({ record: () => {} }),
				createObservableGauge: () => ({ addCallback: () => {} }),
			}),
		},
		context: { active: () => ({}), with: (_ctx: unknown, fn: () => unknown) => fn() },
		// extract returns the active context unchanged (no inbound parent);
		// inject is a no-op (no provider) — mirrors real OTel when unconfigured.
		propagation: { extract: (ctx: unknown) => ctx, inject: () => {} },
		SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
		SpanStatusCode: { OK: 0, ERROR: 1 },
		isSpanContextValid: () => false,
	};
}
