import type { HelperResponse } from "@nanoservice-ts/helper";
import type { NanoService } from "@nanoservice-ts/runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SSEClient, type SSEConnectionEvent, type SSEEvent, SSETrigger } from "./SSETrigger";

// Mock implementations
class TestSSETrigger extends SSETrigger {
	protected override nodes = {} as Record<string, NanoService<unknown>>;
	protected override workflows = {} as Record<string, HelperResponse>;

	// Expose protected methods for testing
	public getSSEWorkflowsTest() {
		return this.getSSEWorkflows();
	}

	public findMatchingWorkflowTest(event: SSEConnectionEvent) {
		return this.findMatchingWorkflow(event);
	}

	public formatEventTest(event: SSEEvent) {
		return this.formatEvent(event);
	}

	public setWorkflows(workflows: Record<string, HelperResponse>) {
		this.workflows = workflows;
		this.loadWorkflows();
	}

	public getClientsMap() {
		return this.clients;
	}

	public getChannelsMap() {
		return this.channels;
	}

	public getEventHistory() {
		return this.eventHistory;
	}
}

describe("SSETrigger", () => {
	let trigger: TestSSETrigger;

	beforeEach(() => {
		trigger = new TestSSETrigger();
	});

	afterEach(async () => {
		await trigger.stop();
	});

	describe("SSEEvent Interface", () => {
		it("should define event structure correctly", () => {
			const event: SSEEvent = {
				id: "event-123",
				event: "notification",
				data: { message: "Hello, World!" },
				retry: 3000,
			};

			expect(event.id).toBe("event-123");
			expect(event.event).toBe("notification");
			expect(event.data).toEqual({ message: "Hello, World!" });
			expect(event.retry).toBe(3000);
		});

		it("should support string data", () => {
			const event: SSEEvent = {
				id: "event-456",
				event: "message",
				data: "Plain text message",
			};

			expect(event.data).toBe("Plain text message");
		});
	});

	describe("SSEClient Interface", () => {
		it("should define client structure correctly", () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client: SSEClient = {
				id: "client-123",
				state: "connected",
				channels: new Set(["notifications", "updates"]),
				metadata: { userId: "user-456" },
				connectedAt: new Date(),
				lastActivity: new Date(),
				lastEventId: "event-100",
				write: mockWrite,
				close: mockClose,
			};

			expect(client.id).toBe("client-123");
			expect(client.state).toBe("connected");
			expect(client.channels.has("notifications")).toBe(true);
			expect(client.lastEventId).toBe("event-100");
		});
	});

	describe("SSEConnectionEvent Interface", () => {
		it("should define connect event", () => {
			const event: SSEConnectionEvent = {
				type: "connect",
				clientId: "client-123",
				lastEventId: "event-100",
			};

			expect(event.type).toBe("connect");
			expect(event.clientId).toBe("client-123");
			expect(event.lastEventId).toBe("event-100");
		});

		it("should define subscribe event with channel", () => {
			const event: SSEConnectionEvent = {
				type: "subscribe",
				clientId: "client-123",
				channel: "notifications",
			};

			expect(event.type).toBe("subscribe");
			expect(event.channel).toBe("notifications");
		});

		it("should define disconnect event", () => {
			const event: SSEConnectionEvent = {
				type: "disconnect",
				clientId: "client-123",
			};

			expect(event.type).toBe("disconnect");
		});
	});

	describe("Event Formatting", () => {
		it("should format basic event correctly", () => {
			const event: SSEEvent = {
				id: "event-123",
				event: "message",
				data: "Hello",
			};

			const formatted = trigger.formatEventTest(event);

			expect(formatted).toBe("id: event-123\ndata: Hello\n\n");
		});

		it("should format event with custom event type", () => {
			const event: SSEEvent = {
				id: "event-123",
				event: "notification",
				data: "Hello",
			};

			const formatted = trigger.formatEventTest(event);

			expect(formatted).toContain("event: notification");
			expect(formatted).toContain("id: event-123");
			expect(formatted).toContain("data: Hello");
		});

		it("should format event with JSON data", () => {
			const event: SSEEvent = {
				id: "event-123",
				event: "update",
				data: { status: "active", count: 42 },
			};

			const formatted = trigger.formatEventTest(event);

			expect(formatted).toContain('data: {"status":"active","count":42}');
		});

		it("should format event with retry", () => {
			const event: SSEEvent = {
				id: "event-123",
				event: "message",
				data: "Hello",
				retry: 5000,
			};

			const formatted = trigger.formatEventTest(event);

			expect(formatted).toContain("retry: 5000");
		});

		it("should handle multiline data", () => {
			const event: SSEEvent = {
				id: "event-123",
				event: "message",
				data: "Line 1\nLine 2\nLine 3",
			};

			const formatted = trigger.formatEventTest(event);

			expect(formatted).toContain("data: Line 1");
			expect(formatted).toContain("data: Line 2");
			expect(formatted).toContain("data: Line 3");
		});
	});

	describe("Connection Management", () => {
		it("should handle new connections", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});

			expect(client).not.toBeNull();
			expect(client?.id).toBeDefined();
			expect(client?.state).toBe("connected");
			expect(trigger.getClientsMap().size).toBe(1);
		});

		it("should send initial retry interval on connection", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			await trigger.handleConnection(mockWrite, mockClose, {}, {});

			// Should have sent retry interval
			expect(mockWrite).toHaveBeenCalledWith(expect.stringContaining("retry:"));
		});

		it("should reject connections when at max capacity", async () => {
			// Set max to 1
			(trigger as unknown as { maxClients: number }).maxClients = 1;

			const mockWrite1 = vi.fn().mockReturnValue(true);
			const mockClose1 = vi.fn();
			const mockWrite2 = vi.fn().mockReturnValue(true);
			const mockClose2 = vi.fn();

			await trigger.handleConnection(mockWrite1, mockClose1, {}, {});
			const client2 = await trigger.handleConnection(mockWrite2, mockClose2, {}, {});

			expect(client2).toBeNull();
			expect(mockClose2).toHaveBeenCalled();
		});

		it("should handle disconnection", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});

			expect(trigger.getClientsMap().size).toBe(1);

			await trigger.handleDisconnect(client!.id);

			expect(trigger.getClientsMap().size).toBe(0);
		});

		it("should capture Last-Event-ID on connection", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, { "last-event-id": "event-100" }, {});

			expect(client?.lastEventId).toBe("event-100");
		});
	});

	describe("Channel Management", () => {
		it("should allow clients to subscribe to channels", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});

			await trigger.subscribe(client!.id, "notifications");

			expect(client!.channels.has("notifications")).toBe(true);
			expect(trigger.getChannelsMap().get("notifications")?.clients.has(client!.id)).toBe(true);
		});

		it("should allow clients to unsubscribe from channels", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});

			await trigger.subscribe(client!.id, "notifications");
			await trigger.unsubscribe(client!.id, "notifications");

			expect(client!.channels.has("notifications")).toBe(false);
			// Channel should be deleted when empty
			expect(trigger.getChannelsMap().has("notifications")).toBe(false);
		});

		it("should clean up channels when client disconnects", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});

			await trigger.subscribe(client!.id, "channel1");
			await trigger.subscribe(client!.id, "channel2");

			await trigger.handleDisconnect(client!.id);

			// Channels should be cleaned up
			expect(trigger.getChannelsMap().size).toBe(0);
		});
	});

	describe("Event Sending", () => {
		it("should send event to specific client", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});
			mockWrite.mockClear(); // Clear the retry call

			const success = trigger.sendToClient(client!.id, {
				id: "event-123",
				event: "notification",
				data: { message: "Hello" },
			});

			expect(success).toBe(true);
			expect(mockWrite).toHaveBeenCalled();
			const callArg = mockWrite.mock.calls[0][0];
			expect(callArg).toContain("id: event-123");
			expect(callArg).toContain("event: notification");
		});

		it("should broadcast to channel", async () => {
			const mockWrite1 = vi.fn().mockReturnValue(true);
			const mockClose1 = vi.fn();
			const mockWrite2 = vi.fn().mockReturnValue(true);
			const mockClose2 = vi.fn();
			const mockWrite3 = vi.fn().mockReturnValue(true);
			const mockClose3 = vi.fn();

			const client1 = await trigger.handleConnection(mockWrite1, mockClose1, {}, {});
			const client2 = await trigger.handleConnection(mockWrite2, mockClose2, {}, {});
			await trigger.handleConnection(mockWrite3, mockClose3, {}, {});

			await trigger.subscribe(client1!.id, "notifications");
			await trigger.subscribe(client2!.id, "notifications");
			// client3 is not subscribed

			mockWrite1.mockClear();
			mockWrite2.mockClear();
			mockWrite3.mockClear();

			const count = trigger.broadcastToChannel("notifications", {
				id: "event-123",
				event: "update",
				data: { status: "active" },
			});

			expect(count).toBe(2);
			expect(mockWrite1).toHaveBeenCalled();
			expect(mockWrite2).toHaveBeenCalled();
			expect(mockWrite3).not.toHaveBeenCalled();
		});

		it("should broadcast to all clients", async () => {
			const mockWrite1 = vi.fn().mockReturnValue(true);
			const mockClose1 = vi.fn();
			const mockWrite2 = vi.fn().mockReturnValue(true);
			const mockClose2 = vi.fn();

			await trigger.handleConnection(mockWrite1, mockClose1, {}, {});
			await trigger.handleConnection(mockWrite2, mockClose2, {}, {});

			mockWrite1.mockClear();
			mockWrite2.mockClear();

			const count = trigger.broadcastToAll({
				id: "event-123",
				event: "system",
				data: { message: "Maintenance" },
			});

			expect(count).toBe(2);
			expect(mockWrite1).toHaveBeenCalled();
			expect(mockWrite2).toHaveBeenCalled();
		});

		it("should store events in history for replay", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});
			await trigger.subscribe(client!.id, "notifications");

			trigger.broadcastToChannel("notifications", {
				id: "event-1",
				event: "update",
				data: { count: 1 },
			});

			trigger.broadcastToChannel("notifications", {
				id: "event-2",
				event: "update",
				data: { count: 2 },
			});

			const history = trigger.getEventHistory().get("notifications");
			expect(history).toBeDefined();
			expect(history?.length).toBe(2);
		});
	});

	describe("Heartbeat", () => {
		it("should send heartbeat comment", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});
			mockWrite.mockClear();

			const success = trigger.sendHeartbeat(client!.id);

			expect(success).toBe(true);
			expect(mockWrite).toHaveBeenCalledWith(": heartbeat\n\n");
		});
	});

	describe("Statistics", () => {
		it("should track connection stats", async () => {
			const mockWrite1 = vi.fn().mockReturnValue(true);
			const mockClose1 = vi.fn();
			const mockWrite2 = vi.fn().mockReturnValue(true);
			const mockClose2 = vi.fn();

			await trigger.handleConnection(mockWrite1, mockClose1, {}, {});
			const client2 = await trigger.handleConnection(mockWrite2, mockClose2, {}, {});

			await trigger.subscribe(client2!.id, "notifications");

			const stats = trigger.getStats();

			expect(stats.activeConnections).toBe(2);
			expect(stats.channelCount).toBe(1);
			expect(stats.clientsByChannel.notifications).toBe(1);
		});

		it("should track total events sent", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});

			trigger.sendToClient(client!.id, { id: "e1", event: "test", data: "1" });
			trigger.sendToClient(client!.id, { id: "e2", event: "test", data: "2" });
			trigger.sendToClient(client!.id, { id: "e3", event: "test", data: "3" });

			const stats = trigger.getStats();
			expect(stats.totalEventsSent).toBe(3);
		});
	});

	describe("Lifecycle", () => {
		it("should initialize successfully", async () => {
			const elapsed = await trigger.listen();
			expect(elapsed).toBeGreaterThanOrEqual(0);
		});

		it("should stop and clean up", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			await trigger.handleConnection(mockWrite, mockClose, {}, {});

			await trigger.stop();

			expect(trigger.getClientsMap().size).toBe(0);
			expect(trigger.getChannelsMap().size).toBe(0);
			expect(mockClose).toHaveBeenCalled();
		});
	});

	describe("Client Retrieval", () => {
		it("should get client by ID", async () => {
			const mockWrite = vi.fn().mockReturnValue(true);
			const mockClose = vi.fn();

			const client = await trigger.handleConnection(mockWrite, mockClose, {}, {});

			const retrieved = trigger.getClient(client!.id);
			expect(retrieved).toBe(client);
		});

		it("should get clients in channel", async () => {
			const mockWrite1 = vi.fn().mockReturnValue(true);
			const mockClose1 = vi.fn();
			const mockWrite2 = vi.fn().mockReturnValue(true);
			const mockClose2 = vi.fn();

			const client1 = await trigger.handleConnection(mockWrite1, mockClose1, {}, {});
			const client2 = await trigger.handleConnection(mockWrite2, mockClose2, {}, {});

			await trigger.subscribe(client1!.id, "notifications");
			await trigger.subscribe(client2!.id, "notifications");

			const clients = trigger.getClientsInChannel("notifications");
			expect(clients.length).toBe(2);
		});
	});
});

describe("SSETriggerOpts Schema", () => {
	it("should validate with default values", async () => {
		const { SSETriggerOptsSchema } = await import("@nanoservice-ts/helper");

		const opts = SSETriggerOptsSchema.parse({});

		expect(opts.events).toEqual(["*"]);
		expect(opts.maxConnections).toBe(10000);
		expect(opts.heartbeatInterval).toBe(30000);
		expect(opts.retryInterval).toBe(3000);
	});

	it("should validate custom configuration", async () => {
		const { SSETriggerOptsSchema } = await import("@nanoservice-ts/helper");

		const opts = SSETriggerOptsSchema.parse({
			events: ["connect", "disconnect", "subscribe.*"],
			channels: ["notifications", "updates"],
			path: "/events",
			maxConnections: 5000,
			heartbeatInterval: 15000,
			retryInterval: 5000,
		});

		expect(opts.events).toEqual(["connect", "disconnect", "subscribe.*"]);
		expect(opts.channels).toEqual(["notifications", "updates"]);
		expect(opts.path).toBe("/events");
		expect(opts.retryInterval).toBe(5000);
	});
});
