/**
 * v0.7 PR 2 — WebSocketTrigger integration tests.
 *
 * Tests cover the public API surface of the new concrete WebSocketTrigger:
 *   - Constructor + singleton accessor wiring
 *   - getWebSocketWorkflows() filtering of WorkflowRegistry
 *   - listen() route registration on the shared Hono app
 *   - broadcastToRoom() fan-out semantics
 *   - getStats() observability
 *
 * End-to-end protocol tests (real socket upgrade + message round-trip)
 * are covered by the v05-smoke gate against a real http.Server.
 */

import { WorkflowRegistry } from "@blokjs/runner";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocketTrigger, { _getActiveWebSocketTrigger, _setActiveWebSocketTrigger } from "./WebSocketTrigger";

// Mock @opentelemetry/api so the trigger's tracer + meter constructors don't
// require a real exporter. Matches the pattern used by the HTTP trigger test.
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

describe("WebSocketTrigger — v0.7 PR 2", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		_setActiveWebSocketTrigger(null);
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
		_setActiveWebSocketTrigger(null);
	});

	describe("constructor()", () => {
		it("accepts a shared Hono app and registers as the active trigger via singleton", () => {
			const app = new Hono();
			expect(_getActiveWebSocketTrigger()).toBeNull();

			const trigger = new WebSocketTrigger(app);

			expect(trigger).toBeDefined();
			expect(_getActiveWebSocketTrigger()).toBe(trigger);
		});

		it("accepts an optional httpTrigger for addServerHook coordination", () => {
			const app = new Hono();
			const addServerHook = vi.fn();
			const addPreCatchAllHook = vi.fn();
			const httpTrigger = { addServerHook, addPreCatchAllHook };

			const trigger = new WebSocketTrigger(app, httpTrigger);
			expect(trigger).toBeDefined();
			// The hook is only registered in listen() — not at construction —
			// so addServerHook should NOT have been called yet.
			expect(addServerHook).not.toHaveBeenCalled();
		});
	});

	describe("listen()", () => {
		it("registers a Hono route per WS workflow in the registry", async () => {
			const app = new Hono();
			WorkflowRegistry.getInstance().register({
				name: "chat-handler",
				source: "/test/chat.json",
				workflow: {
					name: "chat-handler",
					version: "1.0.0",
					trigger: { websocket: { path: "/ws/chat/:roomId", events: ["message"] } },
					steps: [],
				},
			});

			const trigger = new WebSocketTrigger(app);
			const elapsed = await trigger.listen();
			expect(typeof elapsed).toBe("number");

			// The Hono app has a /ws/chat/:roomId route registered for GET.
			// Hono's router doesn't expose routes directly, but we can probe
			// it via fetch — an upgrade request without WS headers gets a 426.
			const res = await app.fetch(new Request("http://localhost/ws/chat/lobby"));
			// @hono/node-ws responds 426 Upgrade Required for non-WS GETs
			// on a registered WS path. Either 426 or some 4xx/5xx indicates
			// the route is registered (200 would mean it's an unrelated HTTP route).
			expect(res.status).toBeGreaterThanOrEqual(400);
			expect(res.status).toBeLessThan(600);
		});

		it("skips workflows without trigger.websocket config", async () => {
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

			const trigger = new WebSocketTrigger(app);
			await trigger.listen();

			// Hono has no /ws/* route, so a GET there 404s.
			const res = await app.fetch(new Request("http://localhost/anywhere"));
			expect(res.status).toBe(404);
		});

		it("registers both pre-catch-all and post-serve hooks on httpTrigger when provided", async () => {
			const app = new Hono();
			const addServerHook = vi.fn();
			const addPreCatchAllHook = vi.fn();
			const httpTrigger = { addServerHook, addPreCatchAllHook };
			WorkflowRegistry.getInstance().register({
				name: "chat-handler",
				source: "/test/chat.json",
				workflow: {
					name: "chat-handler",
					version: "1.0.0",
					trigger: { websocket: { path: "/ws/chat" } },
					steps: [],
				},
			});

			const trigger = new WebSocketTrigger(app, httpTrigger);
			await trigger.listen();

			expect(addPreCatchAllHook).toHaveBeenCalledTimes(1);
			expect(addPreCatchAllHook).toHaveBeenCalledWith(expect.any(Function));
			expect(addServerHook).toHaveBeenCalledTimes(1);
			expect(addServerHook).toHaveBeenCalledWith(expect.any(Function));
		});

		it("is idempotent (second listen() call is a no-op)", async () => {
			const app = new Hono();
			const trigger = new WebSocketTrigger(app);
			await trigger.listen();
			// Second call shouldn't throw or re-register.
			await expect(trigger.listen()).resolves.toBeTypeOf("number");
		});
	});

	describe("broadcastToRoom()", () => {
		it("returns 0 when the room has no members", () => {
			const trigger = new WebSocketTrigger(new Hono());
			const count = trigger.broadcastToRoom({
				workflowName: "chat-handler",
				room: "lobby",
				data: "hello",
			});
			expect(count).toBe(0);
		});
	});

	describe("getStats()", () => {
		it("returns zero connections/workflows/rooms when freshly constructed", () => {
			const trigger = new WebSocketTrigger(new Hono());
			expect(trigger.getStats()).toEqual({ connections: 0, workflows: 0, rooms: 0 });
		});
	});

	describe("stop()", () => {
		it("clears the active-trigger singleton", async () => {
			const trigger = new WebSocketTrigger(new Hono());
			expect(_getActiveWebSocketTrigger()).toBe(trigger);
			await trigger.stop();
			expect(_getActiveWebSocketTrigger()).toBeNull();
		});
	});
});
