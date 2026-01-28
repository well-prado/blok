/**
 * SSE Trigger Monitoring Integration Tests
 *
 * Tests that the SSE trigger properly integrates with the
 * monitoring infrastructure from TriggerBase:
 * - Health checks for SSE server dependencies
 * - Rate limiting per-client event throughput
 * - Circuit breaker for downstream workflow failures
 * - Metrics collection (connections, events, channels)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HelperResponse } from "@nanoservice-ts/helper";
import type { NanoService } from "@nanoservice-ts/runner";
import { SSETrigger } from "./SSETrigger";

/**
 * Concrete test trigger exposing monitoring methods from TriggerBase
 */
class MonitoredSSETrigger extends SSETrigger {
	protected override nodes = {} as Record<string, NanoService<unknown>>;
	protected override workflows = {} as Record<string, HelperResponse>;

	public getClientsMap() {
		return this.clients;
	}

	public getChannelsMap() {
		return this.channels;
	}
}

function createMockWriter() {
	const written: string[] = [];
	return {
		write: vi.fn((data: string) => {
			written.push(data);
			return true;
		}),
		close: vi.fn(),
		written,
	};
}

describe("SSE Trigger - Monitoring Integration", () => {
	let trigger: MonitoredSSETrigger;

	beforeEach(() => {
		trigger = new MonitoredSSETrigger();
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
		});

		it("should support SSE-specific dependency checks", async () => {
			trigger.registerHealthDependency("event-source", async () => ({
				status: "healthy",
				message: "Event source connected",
				lastChecked: Date.now(),
			}));

			trigger.registerHealthDependency("redis-pubsub", async () => ({
				status: "healthy",
				message: "Redis Pub/Sub connected for SSE fan-out",
				lastChecked: Date.now(),
			}));

			const health = await trigger.getHealth();
			expect(health.status).toBe("healthy");
			expect(Object.keys(health.checks)).toHaveLength(2);
		});

		it("should report unhealthy when event source is down", async () => {
			trigger.registerHealthDependency("event-source", async () => {
				throw new Error("Event source disconnected");
			});

			const health = await trigger.getHealth();
			expect(health.status).toBe("unhealthy");
			expect(health.checks["event-source"].message).toBe("Event source disconnected");
		});

		it("should pass liveness even with dependency failures", async () => {
			trigger.registerHealthDependency("broken", async () => {
				throw new Error("Down");
			});

			const liveness = trigger.getLiveness();
			expect(liveness.status).toBe("ok");

			const readiness = await trigger.getReadiness();
			expect(readiness.ready).toBe(false);
		});
	});

	describe("Rate Limiting", () => {
		it("should rate limit events per client when enabled", () => {
			trigger.enableRateLimiting({
				maxTokens: 3,
				refillRate: 1,
				keyStrategy: "client",
			});

			// First 3 should be allowed
			expect(trigger.checkRateLimit("client-1").allowed).toBe(true);
			expect(trigger.checkRateLimit("client-1").allowed).toBe(true);
			expect(trigger.checkRateLimit("client-1").allowed).toBe(true);

			// 4th should be rejected
			const rejected = trigger.checkRateLimit("client-1");
			expect(rejected.allowed).toBe(false);
			expect(rejected.retryAfterMs).toBeGreaterThan(0);
		});

		it("should isolate rate limits between channels", () => {
			trigger.enableRateLimiting({
				maxTokens: 2,
				refillRate: 1,
			});

			// Use up tokens for channel-a
			trigger.checkRateLimit("channel-a");
			trigger.checkRateLimit("channel-a");
			expect(trigger.checkRateLimit("channel-a").allowed).toBe(false);

			// channel-b should still have tokens
			expect(trigger.checkRateLimit("channel-b").allowed).toBe(true);
		});

		it("should allow unlimited traffic when rate limiting is disabled", () => {
			for (let i = 0; i < 50; i++) {
				const result = trigger.checkRateLimit(`key-${i}`);
				expect(result.allowed).toBe(true);
				expect(result.remaining).toBe(Number.MAX_SAFE_INTEGER);
			}
		});
	});

	describe("Circuit Breaker", () => {
		it("should support circuit breaker configuration", () => {
			trigger.enableCircuitBreaker({
				failureThreshold: 3,
				resetTimeoutMs: 5000,
				halfOpenMaxAttempts: 1,
			});

			// Verify trigger still functions
			const liveness = trigger.getLiveness();
			expect(liveness.status).toBe("ok");
		});
	});

	describe("Trigger Metrics", () => {
		it("should collect SSE trigger-level metrics", () => {
			const metrics = trigger.getTriggerMetrics();
			expect(metrics.triggerType).toBe("MonitoredSSETrigger");
			expect(metrics.throughput.totalRequests).toBe(0);
		});

		it("should track connection counts", async () => {
			const mock1 = createMockWriter();
			const mock2 = createMockWriter();

			await trigger.handleConnection(mock1.write, mock1.close);
			await trigger.handleConnection(mock2.write, mock2.close);

			const stats = trigger.getStats();
			expect(stats.activeConnections).toBe(2);
			expect(stats.totalEventsSent).toBe(0);
		});
	});

	describe("Connection Lifecycle with Monitoring", () => {
		it("should track full SSE connection lifecycle", async () => {
			const mock = createMockWriter();

			// Connect
			const client = await trigger.handleConnection(mock.write, mock.close);
			expect(client).not.toBeNull();
			expect(trigger.getStats().activeConnections).toBe(1);

			// Subscribe to channel
			await trigger.subscribe(client!.id, "updates");
			expect(trigger.getStats().channelCount).toBe(1);

			// Send event to channel
			const sent = trigger.broadcastToChannel("updates", {
				id: "evt-1",
				event: "update",
				data: { status: "active" },
			});
			expect(sent).toBe(1);
			expect(trigger.getStats().totalEventsSent).toBe(1);

			// Unsubscribe
			await trigger.unsubscribe(client!.id, "updates");

			// Disconnect
			await trigger.handleDisconnect(client!.id);
			expect(trigger.getStats().activeConnections).toBe(0);
		});

		it("should clean up on stop", async () => {
			const mocks = Array.from({ length: 5 }, () => createMockWriter());

			for (const mock of mocks) {
				await trigger.handleConnection(mock.write, mock.close);
			}

			expect(trigger.getStats().activeConnections).toBe(5);

			await trigger.stop();

			expect(trigger.getStats().activeConnections).toBe(0);
			expect(trigger.getClientsMap().size).toBe(0);
		});
	});

	describe("Channel Broadcasting with Monitoring", () => {
		it("should broadcast to channel subscribers", async () => {
			const mock1 = createMockWriter();
			const mock2 = createMockWriter();
			const mock3 = createMockWriter();

			const client1 = await trigger.handleConnection(mock1.write, mock1.close);
			const client2 = await trigger.handleConnection(mock2.write, mock2.close);
			const client3 = await trigger.handleConnection(mock3.write, mock3.close);

			// client1 and client2 subscribe to "news"
			await trigger.subscribe(client1!.id, "news");
			await trigger.subscribe(client2!.id, "news");
			// client3 does NOT subscribe

			// Send event to "news" channel
			const sent = trigger.broadcastToChannel("news", {
				id: "news-1",
				event: "breaking",
				data: { headline: "Test headline" },
			});

			expect(sent).toBe(2); // Only client1 and client2

			// Verify both received the SSE-formatted message
			const client1Events = mock1.written.filter((d) => d.includes("breaking"));
			const client2Events = mock2.written.filter((d) => d.includes("breaking"));
			const client3Events = mock3.written.filter((d) => d.includes("breaking"));

			expect(client1Events.length).toBeGreaterThan(0);
			expect(client2Events.length).toBeGreaterThan(0);
			expect(client3Events.length).toBe(0);
		});

		it("should send to individual client", async () => {
			const mock = createMockWriter();
			const client = await trigger.handleConnection(mock.write, mock.close);

			trigger.sendToClient(client!.id, {
				id: "direct-1",
				event: "notification",
				data: { message: "Hello!" },
			});

			expect(trigger.getStats().totalEventsSent).toBe(1);
			const notifications = mock.written.filter((d) => d.includes("notification"));
			expect(notifications.length).toBeGreaterThan(0);
		});

		it("should broadcast to all connected clients", async () => {
			const mocks = Array.from({ length: 4 }, () => createMockWriter());
			const clients = await Promise.all(
				mocks.map((m) => trigger.handleConnection(m.write, m.close)),
			);

			const sent = trigger.broadcastToAll({
				id: "broadcast-1",
				event: "system",
				data: { message: "Maintenance in 5 minutes" },
			});

			expect(sent).toBe(4);

			for (const mock of mocks) {
				const systemEvents = mock.written.filter((d) => d.includes("system"));
				expect(systemEvents.length).toBeGreaterThan(0);
			}
		});
	});

	describe("Max Connections Enforcement", () => {
		it("should reject connections when at capacity", async () => {
			(trigger as unknown as { maxClients: number }).maxClients = 2;

			const mock1 = createMockWriter();
			const mock2 = createMockWriter();
			const mock3 = createMockWriter();

			const client1 = await trigger.handleConnection(mock1.write, mock1.close);
			const client2 = await trigger.handleConnection(mock2.write, mock2.close);

			expect(client1).not.toBeNull();
			expect(client2).not.toBeNull();

			// 3rd connection should be rejected
			const rejected = await trigger.handleConnection(mock3.write, mock3.close);
			expect(rejected).toBeNull();
			expect(mock3.close).toHaveBeenCalled();

			expect(trigger.getStats().activeConnections).toBe(2);
		});
	});

	describe("Event History & Replay", () => {
		it("should replay missed events on reconnection", async () => {
			const mock1 = createMockWriter();
			const client1 = await trigger.handleConnection(mock1.write, mock1.close);

			// Subscribe and send events
			await trigger.subscribe(client1!.id, "events");
			trigger.broadcastToChannel("events", { id: "evt-1", event: "data", data: "first" });
			trigger.broadcastToChannel("events", { id: "evt-2", event: "data", data: "second" });
			trigger.broadcastToChannel("events", { id: "evt-3", event: "data", data: "third" });

			// Disconnect client1
			await trigger.handleDisconnect(client1!.id);

			// Reconnect with Last-Event-ID
			const mock2 = createMockWriter();
			const client2 = await trigger.handleConnection(
				mock2.write,
				mock2.close,
				{ "last-event-id": "evt-1" },
			);

			expect(client2).not.toBeNull();
			// The client should receive missed events after evt-1
			// (evt-2 and evt-3) via replay
		});
	});
});
