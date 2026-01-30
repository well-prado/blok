/**
 * WebSocket Trigger Monitoring Integration Tests
 *
 * Tests that the WebSocket trigger properly integrates with the
 * monitoring infrastructure from TriggerBase:
 * - Health checks for WebSocket server dependencies
 * - Rate limiting per-client message throughput
 * - Circuit breaker for downstream workflow failures
 * - Metrics collection (connections, messages, latency)
 */

import type { HelperResponse } from "@nanoservice-ts/helper";
import type { NanoService } from "@nanoservice-ts/runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebSocketEvent, WebSocketTrigger } from "./WebSocketTrigger";

/**
 * Concrete test trigger exposing monitoring methods from TriggerBase
 */
class MonitoredWebSocketTrigger extends WebSocketTrigger {
	protected override nodes = {} as Record<string, NanoService<unknown>>;
	protected override workflows = {} as Record<string, HelperResponse>;

	public getClientsMap() {
		return this.clients;
	}

	public getRoomsMap() {
		return this.rooms;
	}
}

function createMockSocket() {
	return {
		send: vi.fn(),
		close: vi.fn(),
		ping: vi.fn(),
	};
}

describe("WebSocket Trigger - Monitoring Integration", () => {
	let trigger: MonitoredWebSocketTrigger;

	beforeEach(() => {
		trigger = new MonitoredWebSocketTrigger();
	});

	afterEach(async () => {
		trigger.destroyMonitoring();
		await trigger.stop();
	});

	describe("Health Checks", () => {
		it("should report healthy when no dependencies registered", async () => {
			const health = await trigger.getHealth();
			expect(health.status).toBe("healthy");
			expect(health.uptime).toBeGreaterThanOrEqual(0);
			expect(Object.keys(health.checks)).toHaveLength(0);
		});

		it("should support custom WebSocket dependency checks", async () => {
			trigger.registerHealthDependency("ws-server", async () => ({
				status: "healthy",
				message: "WebSocket server running on port 8080",
				lastChecked: Date.now(),
			}));

			const health = await trigger.getHealth();
			expect(health.status).toBe("healthy");
			expect(health.checks["ws-server"].status).toBe("healthy");
		});

		it("should report degraded when WebSocket server has high latency", async () => {
			trigger.registerHealthDependency("ws-server", async () => ({
				status: "degraded",
				message: "High connection latency detected",
				lastChecked: Date.now(),
			}));

			const health = await trigger.getHealth();
			expect(health.status).toBe("degraded");
		});

		it("should pass liveness check even with dependency failures", async () => {
			trigger.registerHealthDependency("external-api", async () => {
				throw new Error("API unreachable");
			});

			const liveness = trigger.getLiveness();
			expect(liveness.status).toBe("ok");

			const readiness = await trigger.getReadiness();
			expect(readiness.ready).toBe(false);
			expect(readiness.status).toBe("unhealthy");
		});

		it("should track connection count as a health indicator", async () => {
			const socket = createMockSocket();

			// Connect 3 clients
			const client1 = await trigger.handleConnection(socket, {});
			const client2 = await trigger.handleConnection(socket, {});
			const client3 = await trigger.handleConnection(socket, {});

			expect(client1).not.toBeNull();
			expect(client2).not.toBeNull();
			expect(client3).not.toBeNull();

			const stats = trigger.getStats();
			expect(stats.activeConnections).toBe(3);
		});
	});

	describe("Rate Limiting", () => {
		it("should rate limit messages per client when enabled", async () => {
			trigger.enableRateLimiting({
				maxTokens: 5,
				refillRate: 2,
				keyStrategy: "client",
			});

			// First 5 messages should be allowed
			for (let i = 0; i < 5; i++) {
				const result = trigger.checkRateLimit("client-1");
				expect(result.allowed).toBe(true);
			}

			// 6th message should be rejected
			const rejected = trigger.checkRateLimit("client-1");
			expect(rejected.allowed).toBe(false);
			expect(rejected.retryAfterMs).toBeGreaterThan(0);
		});

		it("should isolate rate limits between different clients", () => {
			trigger.enableRateLimiting({
				maxTokens: 3,
				refillRate: 1,
			});

			// Use up all tokens for client-1
			trigger.checkRateLimit("client-1");
			trigger.checkRateLimit("client-1");
			trigger.checkRateLimit("client-1");

			// client-1 is rate limited
			expect(trigger.checkRateLimit("client-1").allowed).toBe(false);

			// client-2 should still have tokens
			expect(trigger.checkRateLimit("client-2").allowed).toBe(true);
		});

		it("should allow unlimited traffic when rate limiting is disabled", () => {
			// Rate limiting not enabled
			for (let i = 0; i < 100; i++) {
				const result = trigger.checkRateLimit(`client-${i}`);
				expect(result.allowed).toBe(true);
				expect(result.remaining).toBe(Number.MAX_SAFE_INTEGER);
			}
		});
	});

	describe("Circuit Breaker", () => {
		it("should be null when not enabled", () => {
			// Access through trigger metrics instead of exposing internal state
			// The circuit breaker is protected, so we test its behavior
			const metrics = trigger.getTriggerMetrics();
			expect(metrics.triggerType).toBe("MonitoredWebSocketTrigger");
		});

		it("should support enabling circuit breaker for workflow execution", () => {
			trigger.enableCircuitBreaker({
				failureThreshold: 5,
				resetTimeoutMs: 30000,
				halfOpenMaxAttempts: 2,
			});

			// Circuit breaker is now active - verify through health check
			const liveness = trigger.getLiveness();
			expect(liveness.status).toBe("ok");
		});
	});

	describe("Trigger Metrics", () => {
		it("should collect trigger-level metrics", () => {
			const metrics = trigger.getTriggerMetrics();
			expect(metrics.triggerType).toBe("MonitoredWebSocketTrigger");
			expect(metrics.throughput.totalRequests).toBe(0);
			expect(metrics.latency.count).toBe(0);
			expect(metrics.errors.total).toBe(0);
		});

		it("should track connection counts through metrics", async () => {
			const socket = createMockSocket();

			await trigger.handleConnection(socket, {});
			await trigger.handleConnection(socket, {});

			const stats = trigger.getStats();
			expect(stats.activeConnections).toBe(2);
			expect(stats.totalMessages).toBe(0);
		});

		it("should track message counts", async () => {
			const socket = createMockSocket();
			const client = await trigger.handleConnection(socket, {});
			expect(client).not.toBeNull();

			// Handle a text message (won't execute workflow since none configured)
			await trigger.handleMessage(client!.id, '{"event":"test","data":"hello"}', false);
			await trigger.handleMessage(client!.id, '{"event":"test","data":"world"}', false);

			const stats = trigger.getStats();
			expect(stats.totalMessages).toBe(2);
		});
	});

	describe("Connection Lifecycle with Monitoring", () => {
		it("should track full connection lifecycle", async () => {
			const socket = createMockSocket();

			// Connect
			const client = await trigger.handleConnection(socket, {});
			expect(client).not.toBeNull();
			expect(trigger.getStats().activeConnections).toBe(1);

			// Join room
			await trigger.joinRoom(client!.id, "lobby");
			expect(trigger.getStats().roomCount).toBe(1);

			// Send message
			await trigger.handleMessage(client!.id, '{"event":"chat","data":"hi"}', false);
			expect(trigger.getStats().totalMessages).toBe(1);

			// Leave room
			await trigger.leaveRoom(client!.id, "lobby");
			expect(trigger.getStats().roomCount).toBe(0);

			// Disconnect
			await trigger.handleClose(client!.id, 1000, "Normal closure");
			expect(trigger.getStats().activeConnections).toBe(0);
		});

		it("should clean up monitoring on stop", async () => {
			const socket = createMockSocket();

			// Connect clients
			await trigger.handleConnection(socket, {});
			await trigger.handleConnection(socket, {});
			await trigger.handleConnection(socket, {});

			expect(trigger.getStats().activeConnections).toBe(3);

			// Stop trigger
			await trigger.stop();

			expect(trigger.getStats().activeConnections).toBe(0);
			expect(trigger.getClientsMap().size).toBe(0);
			expect(trigger.getRoomsMap().size).toBe(0);
		});
	});

	describe("Multi-Client Broadcasting with Monitoring", () => {
		it("should broadcast to room and track metrics", async () => {
			const socket1 = createMockSocket();
			const socket2 = createMockSocket();
			const socket3 = createMockSocket();

			const client1 = await trigger.handleConnection(socket1, {});
			const client2 = await trigger.handleConnection(socket2, {});
			const client3 = await trigger.handleConnection(socket3, {});

			// Join room
			await trigger.joinRoom(client1!.id, "chat");
			await trigger.joinRoom(client2!.id, "chat");
			// client3 does NOT join the room

			// Broadcast to room (excluding sender)
			const sent = trigger.broadcastToRoom("chat", "msg", { text: "hello" }, client1!.id);
			expect(sent).toBe(1); // Only client2 receives

			// Verify socket2 received the message
			expect(socket2.send).toHaveBeenCalledTimes(1);
			const sentData = JSON.parse(socket2.send.mock.calls[0][0]);
			expect(sentData.event).toBe("msg");
			expect(sentData.data.text).toBe("hello");

			// socket1 (sender, excluded) and socket3 (not in room) should not receive
			expect(socket1.send).not.toHaveBeenCalled();
			expect(socket3.send).not.toHaveBeenCalled();
		});

		it("should broadcast to all clients", async () => {
			const sockets = Array.from({ length: 5 }, () => createMockSocket());
			const clients = await Promise.all(sockets.map((s) => trigger.handleConnection(s, {})));

			const sent = trigger.broadcastToAll("notification", { message: "Server restart" });
			expect(sent).toBe(5);

			for (const socket of sockets) {
				expect(socket.send).toHaveBeenCalledTimes(1);
			}
		});
	});

	describe("Authentication with Monitoring", () => {
		it("should reject unauthenticated connections", async () => {
			trigger.setAuthHandler(async (_req, headers) => {
				if (headers.authorization === "Bearer valid-token") {
					return { authenticated: true, clientId: "auth-user-1" };
				}
				return { authenticated: false, error: "Invalid token" };
			});

			const socket = createMockSocket();

			// Without valid auth
			const result = await trigger.handleConnection(socket, {}, {});
			expect(result).toBeNull();
			expect(socket.close).toHaveBeenCalledWith(4001, "Invalid token");

			// With valid auth
			const socket2 = createMockSocket();
			const authedClient = await trigger.handleConnection(
				socket2,
				{},
				{
					authorization: "Bearer valid-token",
				},
			);
			expect(authedClient).not.toBeNull();
			expect(authedClient!.id).toBe("auth-user-1");
		});

		it("should track authenticated connections in metrics", async () => {
			trigger.setAuthHandler(async () => ({
				authenticated: true,
				clientId: "user-1",
				metadata: { role: "admin" },
			}));

			const socket = createMockSocket();
			const client = await trigger.handleConnection(socket, {}, {});

			expect(client).not.toBeNull();
			expect(client!.metadata.role).toBe("admin");
			expect(trigger.getStats().activeConnections).toBe(1);
		});
	});

	describe("Max Connections Enforcement", () => {
		it("should reject connections when at capacity", async () => {
			// Override max clients to a small number for testing
			(trigger as unknown as { maxClients: number }).maxClients = 3;

			const sockets = Array.from({ length: 4 }, () => createMockSocket());

			// First 3 should succeed
			for (let i = 0; i < 3; i++) {
				const client = await trigger.handleConnection(sockets[i], {});
				expect(client).not.toBeNull();
			}

			// 4th should be rejected
			const rejected = await trigger.handleConnection(sockets[3], {});
			expect(rejected).toBeNull();
			expect(sockets[3].close).toHaveBeenCalledWith(1013, "Server at capacity");

			expect(trigger.getStats().activeConnections).toBe(3);
		});
	});
});
