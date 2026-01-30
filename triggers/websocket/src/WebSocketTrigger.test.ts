import type { HelperResponse } from "@blok/helper";
import type { BlokService } from "@blok/runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AuthResult,
	type WebSocketClient,
	type WebSocketEvent,
	type WebSocketMessage,
	WebSocketTrigger,
} from "./WebSocketTrigger";

// Mock implementations
class TestWebSocketTrigger extends WebSocketTrigger {
	protected override nodes = {} as Record<string, BlokService<unknown>>;
	protected override workflows = {} as Record<string, HelperResponse>;

	// Expose protected methods for testing
	public getWebSocketWorkflowsTest() {
		return this.getWebSocketWorkflows();
	}

	public findMatchingWorkflowTest(event: WebSocketEvent) {
		return this.findMatchingWorkflow(event);
	}

	public setWorkflows(workflows: Record<string, HelperResponse>) {
		this.workflows = workflows;
		this.loadWorkflows();
	}

	public getClientsMap() {
		return this.clients;
	}

	public getRoomsMap() {
		return this.rooms;
	}
}

describe("WebSocketTrigger", () => {
	let trigger: TestWebSocketTrigger;

	beforeEach(() => {
		trigger = new TestWebSocketTrigger();
	});

	afterEach(async () => {
		await trigger.stop();
	});

	describe("WebSocketMessage Interface", () => {
		it("should define message structure correctly", () => {
			const message: WebSocketMessage = {
				id: "msg-123",
				type: "text",
				event: "chat.message",
				data: { text: "Hello, World!" },
				timestamp: new Date(),
				raw: '{"event":"chat.message","data":{"text":"Hello, World!"}}',
			};

			expect(message.id).toBe("msg-123");
			expect(message.type).toBe("text");
			expect(message.event).toBe("chat.message");
			expect(message.data).toEqual({ text: "Hello, World!" });
			expect(message.timestamp).toBeInstanceOf(Date);
		});

		it("should support binary message type", () => {
			const binaryData = Buffer.from([0x01, 0x02, 0x03]);
			const message: WebSocketMessage = {
				id: "msg-456",
				type: "binary",
				event: "binary",
				data: binaryData,
				timestamp: new Date(),
				raw: binaryData,
			};

			expect(message.type).toBe("binary");
			expect(message.raw).toBeInstanceOf(Buffer);
		});
	});

	describe("WebSocketClient Interface", () => {
		it("should define client structure correctly", () => {
			const mockSend = vi.fn();
			const mockClose = vi.fn();
			const mockPing = vi.fn();

			const client: WebSocketClient = {
				id: "client-123",
				state: "connected",
				rooms: new Set(["general", "support"]),
				metadata: { userId: "user-456", role: "admin" },
				connectedAt: new Date(),
				lastActivity: new Date(),
				send: mockSend,
				close: mockClose,
				ping: mockPing,
			};

			expect(client.id).toBe("client-123");
			expect(client.state).toBe("connected");
			expect(client.rooms.has("general")).toBe(true);
			expect(client.rooms.has("support")).toBe(true);
			expect(client.metadata.userId).toBe("user-456");
		});
	});

	describe("WebSocketEvent Interface", () => {
		it("should define connection event", () => {
			const event: WebSocketEvent = {
				type: "connection",
				clientId: "client-123",
			};

			expect(event.type).toBe("connection");
			expect(event.clientId).toBe("client-123");
		});

		it("should define message event with payload", () => {
			const event: WebSocketEvent = {
				type: "message",
				clientId: "client-123",
				message: {
					id: "msg-123",
					type: "text",
					event: "chat.message",
					data: { text: "Hello" },
					timestamp: new Date(),
				},
			};

			expect(event.type).toBe("message");
			expect(event.message?.event).toBe("chat.message");
		});

		it("should define close event with code and reason", () => {
			const event: WebSocketEvent = {
				type: "close",
				clientId: "client-123",
				closeCode: 1000,
				closeReason: "Normal closure",
			};

			expect(event.type).toBe("close");
			expect(event.closeCode).toBe(1000);
			expect(event.closeReason).toBe("Normal closure");
		});

		it("should define room events", () => {
			const joinEvent: WebSocketEvent = {
				type: "join_room",
				clientId: "client-123",
				room: "general",
			};

			const leaveEvent: WebSocketEvent = {
				type: "leave_room",
				clientId: "client-123",
				room: "general",
			};

			expect(joinEvent.type).toBe("join_room");
			expect(joinEvent.room).toBe("general");
			expect(leaveEvent.type).toBe("leave_room");
		});
	});

	describe("Connection Management", () => {
		it("should handle new connections", async () => {
			const mockSocket = {
				send: vi.fn(),
				close: vi.fn(),
				ping: vi.fn(),
			};

			const client = await trigger.handleConnection(mockSocket, {}, {});

			expect(client).not.toBeNull();
			expect(client?.id).toBeDefined();
			expect(client?.state).toBe("connected");
			expect(trigger.getClientsMap().size).toBe(1);
		});

		it("should reject connections when at max capacity", async () => {
			// Set max to 1
			(trigger as unknown as { maxClients: number }).maxClients = 1;

			const mockSocket1 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const mockSocket2 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };

			await trigger.handleConnection(mockSocket1, {}, {});
			const client2 = await trigger.handleConnection(mockSocket2, {}, {});

			expect(client2).toBeNull();
			expect(mockSocket2.close).toHaveBeenCalledWith(1013, "Server at capacity");
		});

		it("should handle authentication", async () => {
			trigger.setAuthHandler((_request, headers) => {
				if (headers.authorization === "Bearer valid-token") {
					return {
						authenticated: true,
						clientId: "authenticated-user",
						metadata: { role: "admin" },
					};
				}
				return { authenticated: false, error: "Invalid token" };
			});

			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };

			// Test successful auth
			const validClient = await trigger.handleConnection(mockSocket, {}, { authorization: "Bearer valid-token" });
			expect(validClient?.id).toBe("authenticated-user");
			expect(validClient?.metadata.role).toBe("admin");

			// Test failed auth
			const invalidClient = await trigger.handleConnection(mockSocket, {}, { authorization: "Bearer invalid-token" });
			expect(invalidClient).toBeNull();
			expect(mockSocket.close).toHaveBeenCalledWith(4001, "Invalid token");
		});

		it("should handle disconnection", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			expect(trigger.getClientsMap().size).toBe(1);

			await trigger.handleClose(client!.id, 1000, "Normal closure");

			expect(trigger.getClientsMap().size).toBe(0);
		});
	});

	describe("Room Management", () => {
		it("should allow clients to join rooms", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			await trigger.joinRoom(client!.id, "general");

			expect(client!.rooms.has("general")).toBe(true);
			expect(trigger.getRoomsMap().get("general")?.clients.has(client!.id)).toBe(true);
		});

		it("should allow clients to leave rooms", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			await trigger.joinRoom(client!.id, "general");
			await trigger.leaveRoom(client!.id, "general");

			expect(client!.rooms.has("general")).toBe(false);
			// Room should be deleted when empty
			expect(trigger.getRoomsMap().has("general")).toBe(false);
		});

		it("should clean up rooms when client disconnects", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			await trigger.joinRoom(client!.id, "room1");
			await trigger.joinRoom(client!.id, "room2");

			await trigger.handleClose(client!.id, 1000, "");

			// Rooms should be cleaned up
			expect(trigger.getRoomsMap().size).toBe(0);
		});
	});

	describe("Message Sending", () => {
		it("should send message to specific client", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			const success = trigger.sendToClient(client!.id, "notification", { message: "Hello" });

			expect(success).toBe(true);
			expect(mockSocket.send).toHaveBeenCalledWith(
				JSON.stringify({ event: "notification", data: { message: "Hello" } }),
			);
		});

		it("should broadcast to room", async () => {
			const mockSocket1 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const mockSocket2 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const mockSocket3 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };

			const client1 = await trigger.handleConnection(mockSocket1, {}, {});
			const client2 = await trigger.handleConnection(mockSocket2, {}, {});
			const client3 = await trigger.handleConnection(mockSocket3, {}, {});

			await trigger.joinRoom(client1!.id, "general");
			await trigger.joinRoom(client2!.id, "general");
			// client3 is not in the room

			const count = trigger.broadcastToRoom("general", "chat", { text: "Hello room!" });

			expect(count).toBe(2);
			expect(mockSocket1.send).toHaveBeenCalled();
			expect(mockSocket2.send).toHaveBeenCalled();
			expect(mockSocket3.send).not.toHaveBeenCalled();
		});

		it("should broadcast to room excluding sender", async () => {
			const mockSocket1 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const mockSocket2 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };

			const client1 = await trigger.handleConnection(mockSocket1, {}, {});
			const client2 = await trigger.handleConnection(mockSocket2, {}, {});

			await trigger.joinRoom(client1!.id, "general");
			await trigger.joinRoom(client2!.id, "general");

			// Broadcast excluding client1
			const count = trigger.broadcastToRoom("general", "chat", { text: "Hello!" }, client1!.id);

			expect(count).toBe(1);
			expect(mockSocket1.send).not.toHaveBeenCalled();
			expect(mockSocket2.send).toHaveBeenCalled();
		});

		it("should broadcast to all clients", async () => {
			const mockSocket1 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const mockSocket2 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };

			await trigger.handleConnection(mockSocket1, {}, {});
			await trigger.handleConnection(mockSocket2, {}, {});

			const count = trigger.broadcastToAll("system", { message: "Server maintenance" });

			expect(count).toBe(2);
			expect(mockSocket1.send).toHaveBeenCalled();
			expect(mockSocket2.send).toHaveBeenCalled();
		});
	});

	describe("Message Handling", () => {
		it("should parse JSON messages", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			const jsonMessage = JSON.stringify({ event: "chat.message", data: { text: "Hello" } });
			const result = await trigger.handleMessage(client!.id, jsonMessage, false);

			// No matching workflow, so should return null
			expect(result).toBeNull();
		});

		it("should handle plain text messages", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			const result = await trigger.handleMessage(client!.id, "Hello World", false);

			expect(result).toBeNull();
		});

		it("should handle binary messages", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			const binaryData = Buffer.from([0x01, 0x02, 0x03]);
			const result = await trigger.handleMessage(client!.id, binaryData, true);

			expect(result).toBeNull();
		});

		it("should update last activity on message", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			const initialActivity = client!.lastActivity;

			// Wait a bit
			await new Promise((resolve) => setTimeout(resolve, 10));

			await trigger.handleMessage(client!.id, "test", false);

			expect(client!.lastActivity.getTime()).toBeGreaterThan(initialActivity.getTime());
		});
	});

	describe("Statistics", () => {
		it("should track connection stats", async () => {
			const mockSocket1 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const mockSocket2 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };

			await trigger.handleConnection(mockSocket1, {}, {});
			const client2 = await trigger.handleConnection(mockSocket2, {}, {});

			await trigger.joinRoom(client2!.id, "general");

			const stats = trigger.getStats();

			expect(stats.activeConnections).toBe(2);
			expect(stats.roomCount).toBe(1);
			expect(stats.clientsByRoom.general).toBe(1);
		});

		it("should track message count", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			await trigger.handleMessage(client!.id, "msg1", false);
			await trigger.handleMessage(client!.id, "msg2", false);
			await trigger.handleMessage(client!.id, "msg3", false);

			const stats = trigger.getStats();
			expect(stats.totalMessages).toBe(3);
		});
	});

	describe("Lifecycle", () => {
		it("should initialize successfully", async () => {
			const elapsed = await trigger.listen();
			expect(elapsed).toBeGreaterThanOrEqual(0);
		});

		it("should stop and clean up", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			await trigger.handleConnection(mockSocket, {}, {});

			await trigger.stop();

			expect(trigger.getClientsMap().size).toBe(0);
			expect(trigger.getRoomsMap().size).toBe(0);
			expect(mockSocket.close).toHaveBeenCalledWith(1001, "Server shutting down");
		});
	});

	describe("Client Retrieval", () => {
		it("should get client by ID", async () => {
			const mockSocket = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const client = await trigger.handleConnection(mockSocket, {}, {});

			const retrieved = trigger.getClient(client!.id);
			expect(retrieved).toBe(client);
		});

		it("should get clients in room", async () => {
			const mockSocket1 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };
			const mockSocket2 = { send: vi.fn(), close: vi.fn(), ping: vi.fn() };

			const client1 = await trigger.handleConnection(mockSocket1, {}, {});
			const client2 = await trigger.handleConnection(mockSocket2, {}, {});

			await trigger.joinRoom(client1!.id, "general");
			await trigger.joinRoom(client2!.id, "general");

			const clients = trigger.getClientsInRoom("general");
			expect(clients.length).toBe(2);
		});
	});
});

describe("WebSocketTriggerOpts Schema", () => {
	it("should validate with default values", async () => {
		const { WebSocketTriggerOptsSchema } = await import("@blok/helper");

		const opts = WebSocketTriggerOptsSchema.parse({});

		expect(opts.events).toEqual(["*"]);
		expect(opts.maxConnections).toBe(10000);
		expect(opts.heartbeatInterval).toBe(30000);
		expect(opts.messageRateLimit).toBe(100);
	});

	it("should validate custom configuration", async () => {
		const { WebSocketTriggerOptsSchema } = await import("@blok/helper");

		const opts = WebSocketTriggerOptsSchema.parse({
			events: ["chat.*", "notification"],
			rooms: ["general", "support"],
			path: "/ws",
			maxConnections: 5000,
			heartbeatInterval: 15000,
			messageRateLimit: 50,
		});

		expect(opts.events).toEqual(["chat.*", "notification"]);
		expect(opts.rooms).toEqual(["general", "support"]);
		expect(opts.path).toBe("/ws");
		expect(opts.maxConnections).toBe(5000);
	});
});
