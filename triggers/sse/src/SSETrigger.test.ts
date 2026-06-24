/**
 * SSETrigger — v0.7 PR 3 — unit tests for the public surface.
 *
 * Covers construction, the pre-catch-all hook coordination contract
 * with HttpTrigger, route discovery via WorkflowRegistry, idempotent
 * `listen()`, and the singleton helper accessor. Real-socket
 * end-to-end coverage lives in `SSETrigger.integration.test.ts`.
 */

import { WorkflowRegistry } from "@blokjs/runner";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/api", () => {
	const noop = { setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} };
	return {
		trace: {
			getTracer: () => ({
				startActiveSpan: (...a: unknown[]) => {
					const fn = a.find((x) => typeof x === "function") as ((s: typeof noop) => unknown) | undefined;
					return fn?.(noop);
				},
				startSpan: () => noop,
			}),
			getActiveSpan: () => undefined,
			setSpan: (c: unknown) => c,
		},
		metrics: {
			getMeter: () => ({
				createCounter: () => ({ add: () => {} }),
				createHistogram: () => ({ record: () => {} }),
				createGauge: () => ({ record: () => {} }),
				createObservableGauge: () => ({ addCallback: () => {} }),
			}),
		},
		context: { active: () => ({}), with: (_c: unknown, fn: () => unknown) => fn() },
		propagation: { extract: (c: unknown) => c, inject: () => {} },
		SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
		SpanStatusCode: { OK: 0, ERROR: 1 },
		isSpanContextValid: () => false,
	};
});

import SSETrigger, { _getActiveSSETrigger, _setActiveSSETrigger } from "./SSETrigger";
import { _resetBusForTests, getBus } from "./bus";

describe("SSETrigger — v0.7 PR 3", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		_setActiveSSETrigger(null);
		_resetBusForTests();
	});

	afterEach(() => {
		_setActiveSSETrigger(null);
		_resetBusForTests();
	});

	describe("constructor()", () => {
		it("registers as the active SSE trigger singleton", () => {
			const app = new Hono();
			const trigger = new SSETrigger(app);
			expect(trigger).toBeDefined();
			expect(_getActiveSSETrigger()).toBe(trigger);
		});

		it("accepts an optional httpTrigger for pre-catch-all coordination", () => {
			const app = new Hono();
			const addPreCatchAllHook = vi.fn();
			const httpTrigger = { addPreCatchAllHook };
			const trigger = new SSETrigger(app, httpTrigger);
			expect(trigger).toBeDefined();
			// Hook is registered in listen(), not the constructor.
			expect(addPreCatchAllHook).not.toHaveBeenCalled();
		});
	});

	describe("listen()", () => {
		it("registers a Hono route per SSE workflow when no httpTrigger is provided", async () => {
			const app = new Hono();
			WorkflowRegistry.getInstance().register({
				name: "live-clock",
				source: "/test/clock.json",
				workflow: {
					name: "live-clock",
					version: "1.0.0",
					trigger: { sse: { path: "/sse/clock" } },
					steps: [],
				},
			});

			const trigger = new SSETrigger(app);
			await trigger.listen();

			// A GET to the registered path should be handled (not 404). We
			// don't dispatch through streamSSE here — we just confirm Hono
			// owns the route. Without a registered handler, app.fetch()
			// returns 404.
			const res = await app.fetch(new Request("http://localhost/sse/clock"));
			expect(res.status).not.toBe(404);
		});

		it("skips workflows without trigger.sse config", async () => {
			const app = new Hono();
			WorkflowRegistry.getInstance().register({
				name: "http-only",
				source: "/test/http.json",
				workflow: {
					name: "http-only",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/api/foo" } },
					steps: [],
				},
			});
			const trigger = new SSETrigger(app);
			await trigger.listen();
			const res = await app.fetch(new Request("http://localhost/anywhere"));
			expect(res.status).toBe(404);
		});

		it("registers a pre-catch-all hook on httpTrigger when provided", async () => {
			const app = new Hono();
			const addPreCatchAllHook = vi.fn();
			const httpTrigger = { addPreCatchAllHook };
			WorkflowRegistry.getInstance().register({
				name: "live-clock",
				source: "/test/clock.json",
				workflow: {
					name: "live-clock",
					version: "1.0.0",
					trigger: { sse: { path: "/sse/clock" } },
					steps: [],
				},
			});

			const trigger = new SSETrigger(app, httpTrigger);
			await trigger.listen();

			expect(addPreCatchAllHook).toHaveBeenCalledTimes(1);
			expect(addPreCatchAllHook).toHaveBeenCalledWith(expect.any(Function));
		});

		it("is idempotent — second listen() call is a no-op", async () => {
			const app = new Hono();
			const trigger = new SSETrigger(app);
			await trigger.listen();
			await expect(trigger.listen()).resolves.toBeTypeOf("number");
		});
	});

	describe("stop()", () => {
		it("clears the singleton and resets internal state", async () => {
			const app = new Hono();
			const trigger = new SSETrigger(app);
			await trigger.listen();
			await trigger.stop();
			expect(_getActiveSSETrigger()).toBeNull();
		});
	});

	describe("in-process bus", () => {
		it("delivers published events to live subscribers in publish order", async () => {
			const bus = getBus();
			const iterator = bus.subscribe(["alpha"]);
			bus.publish("alpha", { event: "tick", data: { n: 1 } });
			bus.publish("alpha", { event: "tick", data: { n: 2 } });
			const first = await iterator.next();
			const second = await iterator.next();
			await iterator.return?.();
			expect((first.value as { data: { n: number } }).data.n).toBe(1);
			expect((second.value as { data: { n: number } }).data.n).toBe(2);
		});

		it("replays buffered events whose seq strictly exceeds lastEventId", async () => {
			const bus = getBus();
			const seen: number[] = [];
			const e1 = bus.publish("beta", { data: 1 });
			const e2 = bus.publish("beta", { data: 2 });
			const e3 = bus.publish("beta", { data: 3 });
			expect(e1.id).toBe("1");
			expect(e2.id).toBe("2");
			expect(e3.id).toBe("3");

			const iterator = bus.subscribe(["beta"], "1");
			for (let i = 0; i < 2; i += 1) {
				const next = await iterator.next();
				seen.push((next.value as { data: number }).data);
			}
			await iterator.return?.();
			expect(seen).toEqual([2, 3]);
		});

		it("does not deliver events from channels the subscriber didn't request", async () => {
			const bus = getBus();
			const iterator = bus.subscribe(["only-this"]);
			bus.publish("other", { data: "should-not-see" });
			bus.publish("only-this", { data: "should-see" });
			const result = await iterator.next();
			await iterator.return?.();
			expect((result.value as { data: string }).data).toBe("should-see");
		});
	});
});
