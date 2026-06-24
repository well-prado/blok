/**
 * v0.7 PR 2 — full end-to-end WebSocket trigger integration test.
 *
 * Spins up a real Hono app + @hono/node-server with a real
 * WebSocketTrigger mounted on the shared port. Uses the `ws` client
 * library to connect, send a message, and assert the reply — proving
 * the upgrade handshake, message dispatch, ctx.connection.send, and
 * workflow execution path all work together against a real socket.
 *
 * Complements the unit tests in `WebSocketTrigger.test.ts` (which
 * cover the public API surface in isolation).
 */

import type { Server } from "node:http";
import { NodeMap, WorkflowRegistry, defineNode } from "@blokjs/runner";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod";

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

import WebSocketTriggerClass, { _setActiveWebSocketTrigger } from "./WebSocketTrigger";

// Use a non-default port so the test doesn't clash with whatever's
// listening on 4000.
const TEST_PORT = 4901;

/**
 * Tiny echo node — bypasses applyStepOutput like the wait-inside-*
 * fixtures do, so we don't need a full @blokjs/runner step pipeline.
 * Reads ctx.request.body, calls ctx.connection.send with a JSON-
 * encoded reply, returns success.
 */
const echoNode = defineNode({
	name: "echo-reply",
	description: "test fixture — reply back to ws sender via ctx.connection.send",
	input: z.object({}).passthrough(),
	output: z.object({ replied: z.boolean() }),
	async execute(ctx) {
		if (!ctx.connection) {
			throw new Error("no ctx.connection — was this run via WebSocketTrigger?");
		}
		const event = (ctx.request?.body as { event?: string } | undefined)?.event;
		if (event === "connect") {
			ctx.connection.send(JSON.stringify({ event: "connected", id: ctx.connection.id }));
		} else {
			ctx.connection.send(
				JSON.stringify({
					event: "echo",
					original: ctx.request?.body,
				}),
			);
		}
		return { replied: true };
	},
});

describe("WebSocketTrigger — v0.7 PR 2 integration (real socket)", () => {
	let app: Hono;
	let trigger: InstanceType<typeof WebSocketTriggerClass>;
	let httpServer: Server | null = null;

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		_setActiveWebSocketTrigger(null);
		app = new Hono();
	});

	afterEach(
		() =>
			new Promise<void>((resolve) => {
				if (trigger) void trigger.stop();
				if (httpServer) {
					httpServer.close(() => {
						httpServer = null;
						WorkflowRegistry.resetInstance();
						_setActiveWebSocketTrigger(null);
						resolve();
					});
				} else {
					WorkflowRegistry.resetInstance();
					_setActiveWebSocketTrigger(null);
					resolve();
				}
			}),
	);

	it("echoes a JSON message via real WebSocket upgrade + send + reply", async () => {
		// Register the echo workflow in WorkflowRegistry — same path the
		// HttpTrigger's workflow scan uses at boot.
		const nodes = new NodeMap();
		nodes.addNode("echo-reply", echoNode);

		WorkflowRegistry.getInstance().register({
			name: "ws-echo",
			source: "/test/ws-echo.json",
			workflow: {
				name: "ws-echo",
				version: "1.0.0",
				trigger: { websocket: { path: "/ws/echo" } },
				steps: [
					{
						id: "reply",
						node: "echo-reply",
						type: "module",
						inputs: {},
					},
				],
				nodes: { reply: { inputs: {} } },
			},
		});

		// Instantiate the trigger with NO httpTrigger — we manage the
		// http.Server lifecycle ourselves here.
		trigger = new WebSocketTriggerClass(app);
		// Inject the runner's GlobalOptions so the workflow can resolve "echo-reply".
		trigger.setNodeMap({ nodes });
		await trigger.listen();

		// Start the http.Server, then manually call injectWebSocket since
		// we didn't wire it through HttpTrigger's addServerHook.
		await new Promise<void>((resolve) => {
			httpServer = serve({ fetch: app.fetch, port: TEST_PORT }, () => {
				resolve();
			}) as Server;
		});

		// Attach the WS upgrade listener to the running http.Server. In
		// production this happens via HttpTrigger.addServerHook + the
		// trigger's automatic registration. For the test we do it manually.
		(trigger as unknown as { injectWebSocket: (s: Server) => void }).injectWebSocket(httpServer);

		// Connect a real WS client and round-trip a message.
		const messages: Array<unknown> = [];
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/echo`);
			const timer = setTimeout(() => reject(new Error("WS test timeout")), 5000);

			ws.on("open", () => {
				ws.send(JSON.stringify({ event: "hello", data: { hi: "there" } }));
			});
			ws.on("message", (raw) => {
				const parsed = JSON.parse(raw.toString());
				messages.push(parsed);
				// Expect 2 messages: "connected" (from connect workflow) + "echo" (from message workflow).
				if (messages.length >= 2) {
					clearTimeout(timer);
					ws.close();
					resolve();
				}
			});
			ws.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});

		expect(messages).toHaveLength(2);
		const [connected, echoed] = messages as Array<{ event: string; id?: string; original?: unknown }>;
		expect(connected.event).toBe("connected");
		expect(typeof connected.id).toBe("string");
		expect(echoed.event).toBe("echo");
		expect(echoed.original).toMatchObject({ event: "hello", data: { hi: "there" } });
	}, 15_000);
});
