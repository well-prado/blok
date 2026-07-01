/**
 * v0.7 PR 2 — full end-to-end WebSocket trigger integration test.
 *
 * Spins up a real Hono app + @hono/node-server with a real
 * WebSocketTrigger mounted on the shared port. Uses the `ws` client
 * library (a real RFC6455 client) to connect, exchange frames, and
 * close — proving the upgrade handshake, per-event workflow dispatch,
 * `ctx.connection` (id / metadata / send / attachment), and the full
 * connect → message → disconnect lifecycle all work together against a
 * real socket on a live port (no mock of the transport).
 *
 * Complements the unit tests in `WebSocketTrigger.test.ts` (which
 * cover the public API surface in isolation).
 *
 * Note on `ctx.stream`: WebSocket triggers bind `ctx.connection` (the
 * bidirectional per-connection API), NOT `ctx.stream` — `StreamContext`
 * is SSE-only ("Absent on contexts built for ... WebSocket triggers",
 * per core/shared StreamContext.ts). The server-push path a WS node
 * uses is `ctx.connection.send`, which these tests exercise for real.
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

// Bind to an EPHEMERAL port (0) and read the OS-assigned port back from the
// serve() callback. A fixed port flakes with EADDRINUSE when a concurrent
// suite (or a leftover process) holds it under `nx run-many`.

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
		let echoPort = 0;
		await new Promise<void>((resolve) => {
			httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
				echoPort = info.port;
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
			const ws = new WebSocket(`ws://localhost:${echoPort}/ws/echo`);
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

	it("drives the full connect → bidirectional message → close lifecycle, observed on both ends", async () => {
		// Server-side observation sink. The disconnect node records into
		// this closure so the test can prove the SERVER observed the close,
		// not just the client. Non-vacuous: if the disconnect workflow
		// never ran (wiring broken) this array stays empty and the test fails.
		const serverObserved: Array<{ phase: string; id: string; code?: number; reason?: string }> = [];

		// Lifecycle node — reads ctx.connection metadata (id) on every
		// event, pins per-connection identity via setAttachment on connect,
		// and pushes a server frame back through ctx.connection.send.
		//   - connect:    read id, stash it in attachment, push "welcome".
		//   - message:    read attachment (proves identity survived across
		//                 runs), echo the client payload back (server→client).
		//   - disconnect: read the close code/reason and record it server-side.
		const lifecycleNode = defineNode({
			name: "ws-lifecycle",
			description: "test fixture — exercise ctx.connection across the connect/message/disconnect lifecycle",
			input: z.object({}).passthrough(),
			output: z.object({ ok: z.boolean() }),
			async execute(ctx) {
				const conn = ctx.connection;
				if (!conn) throw new Error("no ctx.connection — was this run via WebSocketTrigger?");
				const body = ctx.request?.body as
					| { event?: string; data?: unknown; code?: number; reason?: string }
					| undefined;
				const event = body?.event;

				if (event === "connect") {
					// ctx.connection metadata read + per-connection state write.
					conn.setAttachment({ connId: conn.id, joinedAt: Date.now() });
					serverObserved.push({ phase: "connect", id: conn.id });
					// Server-push a frame carrying the server-assigned id.
					conn.send(JSON.stringify({ event: "welcome", connId: conn.id }));
				} else if (event === "disconnect") {
					// Server end observes the close with the client's code/reason.
					serverObserved.push({ phase: "disconnect", id: conn.id, code: body?.code, reason: body?.reason });
				} else {
					// Message run: recover per-connection state, echo payload.
					const att = conn.attachment as { connId?: string } | undefined;
					serverObserved.push({ phase: "message", id: conn.id });
					conn.send(
						JSON.stringify({
							event: "echo",
							// Prove the attachment (per-connection state) survived
							// from the connect run to this message run.
							attachmentConnId: att?.connId,
							data: body?.data,
						}),
					);
				}
				return { ok: true };
			},
		});

		const nodes = new NodeMap();
		nodes.addNode("ws-lifecycle", lifecycleNode);

		WorkflowRegistry.getInstance().register({
			name: "ws-lifecycle",
			source: "/test/ws-lifecycle.json",
			workflow: {
				name: "ws-lifecycle",
				version: "1.0.0",
				trigger: { websocket: { path: "/ws/life" } },
				steps: [{ id: "life", node: "ws-lifecycle", type: "module", inputs: {} }],
				nodes: { life: { inputs: {} } },
			},
		});

		trigger = new WebSocketTriggerClass(app);
		trigger.setNodeMap({ nodes });
		await trigger.listen();

		let lifecyclePort = 0;
		await new Promise<void>((resolve) => {
			httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
				lifecyclePort = info.port;
				resolve();
			}) as Server;
		});
		(trigger as unknown as { injectWebSocket: (s: Server) => void }).injectWebSocket(httpServer);

		const CLOSE_CODE = 4001;
		const CLOSE_REASON = "client-done";

		// Client-observed frames + close event.
		const clientFrames: Array<{ event: string; connId?: string; attachmentConnId?: string; data?: unknown }> = [];
		let clientClose: { code: number; reason: string } | null = null;

		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(`ws://localhost:${lifecyclePort}/ws/life`);
			const timer = setTimeout(() => reject(new Error("WS lifecycle timeout")), 6000);

			ws.on("message", (raw) => {
				const parsed = JSON.parse(raw.toString());
				clientFrames.push(parsed);
				if (parsed.event === "welcome") {
					// Client→server frame after the server-push welcome.
					ws.send(JSON.stringify({ event: "ping", data: { n: 42 } }));
				} else if (parsed.event === "echo") {
					// Got the server→client echo — now the client initiates close
					// with a distinctive code/reason so we can assert it flows
					// through to the server's disconnect run.
					ws.close(CLOSE_CODE, CLOSE_REASON);
				}
			});
			// Client end observes the close it initiated.
			ws.on("close", (code, reasonBuf) => {
				clientClose = { code, reason: reasonBuf.toString() };
				clearTimeout(timer);
				resolve();
			});
			ws.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});

		// The server dispatches disconnect asynchronously after the socket
		// closes; give it a beat to run the workflow + free the connection.
		await new Promise((r) => setTimeout(r, 200));

		// --- Client-end assertions (bidirectional: server→client frames) ---
		const welcome = clientFrames.find((f) => f.event === "welcome");
		const echo = clientFrames.find((f) => f.event === "echo");
		expect(welcome).toBeDefined();
		expect(typeof welcome?.connId).toBe("string");
		expect(echo).toBeDefined();
		// The echoed frame carries the client→server payload the server received.
		expect(echo?.data).toEqual({ n: 42 });
		// And the attachment set on connect survived into the message run.
		expect(echo?.attachmentConnId).toBe(welcome?.connId);

		// --- Client observed the close it initiated ---
		expect(clientClose).not.toBeNull();
		expect((clientClose as unknown as { code: number }).code).toBe(CLOSE_CODE);
		expect((clientClose as unknown as { reason: string }).reason).toBe(CLOSE_REASON);

		// --- Server-end assertions (the close reached the disconnect run) ---
		const phases = serverObserved.map((o) => o.phase);
		expect(phases).toEqual(["connect", "message", "disconnect"]);
		const connId = welcome?.connId;
		// Every phase ran on the SAME server-side connection id.
		expect(new Set(serverObserved.map((o) => o.id))).toEqual(new Set([connId]));
		// The server's disconnect run saw the exact close code + reason the
		// client sent — proving the close propagated end-to-end.
		const disconnect = serverObserved.find((o) => o.phase === "disconnect");
		expect(disconnect?.code).toBe(CLOSE_CODE);
		expect(disconnect?.reason).toBe(CLOSE_REASON);

		// Server freed the connection after the disconnect run completed.
		expect(trigger.getStats().connections).toBe(0);
	}, 20_000);
});
