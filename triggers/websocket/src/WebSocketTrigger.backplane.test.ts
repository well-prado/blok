/**
 * WebSocket cross-process broadcast backplane integration test —
 * v0.7 follow-up.
 *
 * Two `WebSocketTrigger` instances share a mock pub/sub backplane
 * (a simple in-memory event bus that the test wires manually so we
 * don't need a real broker). Each instance maintains its own
 * `connections` + `rooms` maps; the test verifies:
 *
 *   1. A broadcast from instance A reaches instance B's connections
 *      in the same workflow-scoped room.
 *   2. A broadcast does NOT echo back to instance A (senderId dedupe).
 *   3. The `exceptConnectionId` option is honored on the receiving
 *      side too (cross-process "send to everyone except me").
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
				fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

import type { BackplaneAdapter } from "./Backplane";
import WebSocketTriggerClass, { _setActiveWebSocketTrigger } from "./WebSocketTrigger";

/**
 * In-memory mock pub/sub bus. Every adapter instance registered
 * against this bus shares the same topic→handler[] map; publishing
 * synchronously invokes every subscriber. Synchronous on purpose so
 * test assertions don't need to await broker round-trips.
 */
class MockBus {
	private subscribers: Map<string, Array<(body: unknown) => void>> = new Map();

	subscribe(topic: string, handler: (body: unknown) => void): void {
		let list = this.subscribers.get(topic);
		if (!list) {
			list = [];
			this.subscribers.set(topic, list);
		}
		list.push(handler);
	}

	publish(topic: string, body: unknown): void {
		const list = this.subscribers.get(topic);
		if (!list) return;
		for (const handler of list) handler(body);
	}
}

function mockAdapter(bus: MockBus): BackplaneAdapter {
	return {
		provider: "nats",
		async connect() {},
		async disconnect() {},
		async publish(topic: string, payload: unknown) {
			bus.publish(topic, payload);
		},
		async subscribe(config, handler) {
			bus.subscribe(config.topic, (body) => {
				void handler({ body, topic: config.topic });
			});
		},
	};
}

/**
 * Test-only seam to inject a custom adapter without spinning up a
 * real broker. The trigger normally lazy-imports the adapter via
 * `createBackplaneAdapter`; for the test we patch `backplaneAdapter`
 * directly via the same constructor + `.listen()` path the runtime
 * uses, then overwrite the adapter slot before subscribing.
 */
async function buildTriggerWithMock(bus: MockBus): Promise<{
	trigger: InstanceType<typeof WebSocketTriggerClass>;
	adapter: BackplaneAdapter;
}> {
	const app = new Hono();
	const trigger = new WebSocketTriggerClass(app, undefined, { provider: "nats" });
	// Inject our mock adapter into the trigger's private slots. Keep
	// backplaneConfig non-null (broadcastToRoom checks BOTH adapter
	// and config truthiness before publishing). listen() is never
	// called in this test, so the auto-create + auto-subscribe path
	// is skipped; we wire the bus subscription manually instead.
	const adapter = mockAdapter(bus);
	(trigger as unknown as { backplaneAdapter: BackplaneAdapter | null }).backplaneAdapter = adapter;
	// Subscribe the bus to invoke trigger.onBackplaneMessage on every
	// envelope (mirrors what the trigger's listen() would do via the
	// adapter's subscribe handler).
	bus.subscribe("__blok_ws_broadcast", (body) => {
		(trigger as unknown as { onBackplaneMessage: (b: unknown) => void }).onBackplaneMessage(body);
	});
	return { trigger, adapter };
}

interface MockWSContext {
	send: (data: unknown) => void;
}

/**
 * Inject a fake connection into the trigger's internal maps so
 * broadcast can fan out to it without the full @hono/node-ws upgrade
 * machinery. Returns a `received` array that captures every payload
 * the WSContext's send() method got.
 */
function addFakeConnection(
	trigger: InstanceType<typeof WebSocketTriggerClass>,
	workflowName: string,
	room: string,
	connectionId: string,
): { received: Array<string | Uint8Array> } {
	const received: Array<string | Uint8Array> = [];
	const ws: MockWSContext = {
		send: (data: unknown) => {
			if (typeof data === "string" || data instanceof Uint8Array) {
				received.push(data);
			} else if (data instanceof ArrayBuffer) {
				received.push(new Uint8Array(data));
			}
		},
	};
	const fullRoomName = `${workflowName}:${room}`;
	const t = trigger as unknown as {
		connections: Map<string, unknown>;
		rooms: Map<string, Set<string>>;
		connectionsByWorkflow: Map<string, Set<string>>;
	};
	t.connections.set(connectionId, {
		id: connectionId,
		ws,
		workflowName,
		path: "/",
		pathParams: {},
		rooms: new Set([fullRoomName]),
		attachment: undefined,
		connectedAt: Date.now(),
		lastActivity: Date.now(),
		tokens: 100,
		tokensRefilledAt: Date.now(),
	});
	let roomSet = t.rooms.get(fullRoomName);
	if (!roomSet) {
		roomSet = new Set();
		t.rooms.set(fullRoomName, roomSet);
	}
	roomSet.add(connectionId);
	let wfSet = t.connectionsByWorkflow.get(workflowName);
	if (!wfSet) {
		wfSet = new Set();
		t.connectionsByWorkflow.set(workflowName, wfSet);
	}
	wfSet.add(connectionId);
	return { received };
}

describe("WebSocketTrigger backplane — cross-process broadcast", () => {
	beforeEach(() => {
		_setActiveWebSocketTrigger(null);
	});

	afterEach(async () => {
		_setActiveWebSocketTrigger(null);
	});

	it("broadcast from process A reaches connections owned by process B in the same room", async () => {
		const bus = new MockBus();
		const a = await buildTriggerWithMock(bus);
		const b = await buildTriggerWithMock(bus);

		// Connection on each process, both joined to the same room.
		const aConn = addFakeConnection(a.trigger, "chat", "lobby", "conn-A1");
		const bConn = addFakeConnection(b.trigger, "chat", "lobby", "conn-B1");

		// Process A broadcasts.
		a.trigger.broadcastToRoom({
			workflowName: "chat",
			room: "lobby",
			data: '{"event":"msg","data":"hi"}',
		});

		// Process A's local connection received the message via the
		// local fan-out path.
		expect(aConn.received).toEqual(['{"event":"msg","data":"hi"}']);
		// Process B's connection received it via the backplane.
		expect(bConn.received).toEqual(['{"event":"msg","data":"hi"}']);
	});

	it("does not echo back to the publishing process (senderId dedupe)", async () => {
		const bus = new MockBus();
		const a = await buildTriggerWithMock(bus);
		const b = await buildTriggerWithMock(bus);

		const aConn = addFakeConnection(a.trigger, "chat", "lobby", "conn-A1");
		addFakeConnection(b.trigger, "chat", "lobby", "conn-B1");

		a.trigger.broadcastToRoom({ workflowName: "chat", room: "lobby", data: "first" });

		// Only one entry on A — the local fan-out. The backplane
		// publish round-trips through the bus, but onBackplaneMessage
		// skips it because senderId matches A's own id.
		expect(aConn.received).toEqual(["first"]);
	});

	it("honors exceptConnectionId on the receiving side (`exceptSelf` semantics across processes)", async () => {
		const bus = new MockBus();
		const a = await buildTriggerWithMock(bus);
		const b = await buildTriggerWithMock(bus);

		// Two connections on B in the same room. A broadcasts and
		// asks to skip B's first connection — only the second should
		// receive.
		const b1 = addFakeConnection(b.trigger, "chat", "lobby", "conn-B1");
		const b2 = addFakeConnection(b.trigger, "chat", "lobby", "conn-B2");

		a.trigger.broadcastToRoom({
			workflowName: "chat",
			room: "lobby",
			data: "secret",
			exceptConnectionId: "conn-B1",
		});

		expect(b1.received).toEqual([]);
		expect(b2.received).toEqual(["secret"]);
	});

	it("binary frames (Uint8Array) survive base64 round-trip across the backplane", async () => {
		const bus = new MockBus();
		const a = await buildTriggerWithMock(bus);
		const b = await buildTriggerWithMock(bus);

		addFakeConnection(a.trigger, "binary-wf", "channel", "conn-A1");
		const bConn = addFakeConnection(b.trigger, "binary-wf", "channel", "conn-B1");

		const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		a.trigger.broadcastToRoom({ workflowName: "binary-wf", room: "channel", data: payload });

		expect(bConn.received).toHaveLength(1);
		const received = bConn.received[0];
		expect(received).toBeInstanceOf(Uint8Array);
		expect(Array.from(received as Uint8Array)).toEqual(Array.from(payload));
	});

	it("a connection in a DIFFERENT room is not reached by the backplane fan-out", async () => {
		const bus = new MockBus();
		const a = await buildTriggerWithMock(bus);
		const b = await buildTriggerWithMock(bus);

		addFakeConnection(a.trigger, "chat", "lobby", "conn-A1");
		const bOther = addFakeConnection(b.trigger, "chat", "other-room", "conn-B1");

		a.trigger.broadcastToRoom({ workflowName: "chat", room: "lobby", data: "hi" });

		expect(bOther.received).toEqual([]);
	});
});
