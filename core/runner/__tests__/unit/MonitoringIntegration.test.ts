/**
 * Monitoring Infrastructure Integration Tests
 *
 * Tests that HealthCheck, RateLimiter, CircuitBreaker, and TriggerMetricsCollector
 * work correctly together as integrated into TriggerBase.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../src/monitoring/CircuitBreaker";
import { HealthCheck } from "../../src/monitoring/HealthCheck";
import type { DependencyHealth } from "../../src/monitoring/HealthCheck";
import { RateLimiter } from "../../src/monitoring/RateLimiter";
import { TriggerMetricsCollector } from "../../src/monitoring/TriggerMetricsCollector";

describe("Monitoring Infrastructure Integration", () => {
	let healthCheck: HealthCheck;
	let rateLimiter: RateLimiter;
	let circuitBreaker: CircuitBreaker;
	let metrics: TriggerMetricsCollector;

	beforeEach(() => {
		healthCheck = new HealthCheck(100); // 100ms cache
		rateLimiter = new RateLimiter({ maxTokens: 10, refillRate: 5 }, 60_000);
		circuitBreaker = new CircuitBreaker({
			failureThreshold: 3,
			resetTimeoutMs: 100,
			halfOpenMaxAttempts: 2,
		});
		metrics = new TriggerMetricsCollector("test", "integration-test");
	});

	afterEach(() => {
		rateLimiter.destroy();
		circuitBreaker.destroy();
	});

	describe("Full Request Lifecycle", () => {
		it("should track successful requests through all monitoring layers", async () => {
			// 1. Check health before processing
			const health = await healthCheck.check();
			expect(health.status).toBe("healthy");

			// 2. Check rate limit
			const rateResult = rateLimiter.consume("client-1");
			expect(rateResult.allowed).toBe(true);

			// 3. Execute through circuit breaker
			const start = performance.now();
			const result = await circuitBreaker.execute(async () => {
				return { data: "success" };
			});
			const latency = performance.now() - start;

			// 4. Record metrics
			metrics.recordSuccess(latency);

			// 5. Verify all components updated correctly
			expect(result.data).toBe("success");
			expect(circuitBreaker.getState()).toBe("CLOSED");

			const snapshot = metrics.getMetrics();
			expect(snapshot.throughput.totalRequests).toBe(1);
			expect(snapshot.throughput.successfulRequests).toBe(1);
			expect(snapshot.throughput.successRate).toBe(1);
			expect(snapshot.latency.count).toBe(1);
		});

		it("should handle failed requests across all monitoring layers", async () => {
			// 1. Check rate limit
			const rateResult = rateLimiter.consume("client-1");
			expect(rateResult.allowed).toBe(true);

			// 2. Execute through circuit breaker - will fail
			const start = performance.now();
			try {
				await circuitBreaker.execute(async () => {
					throw new Error("Connection refused");
				});
			} catch (err) {
				const latency = performance.now() - start;
				// 3. Record failure metrics
				metrics.recordFailure(latency, err as Error, "connection");
			}

			// 4. Verify metrics recorded the failure
			const snapshot = metrics.getMetrics();
			expect(snapshot.throughput.totalRequests).toBe(1);
			expect(snapshot.throughput.failedRequests).toBe(1);
			expect(snapshot.throughput.successRate).toBe(0);
			expect(snapshot.errors.total).toBe(1);
			expect(snapshot.errors.byCategory.connection).toBe(1);

			// 5. Circuit breaker should still be CLOSED (1 failure < threshold of 3)
			expect(circuitBreaker.getState()).toBe("CLOSED");
		});

		it("should trip circuit breaker after repeated failures and reject subsequent requests", async () => {
			// Cause 3 failures to trip the circuit breaker
			for (let i = 0; i < 3; i++) {
				const start = performance.now();
				try {
					await circuitBreaker.execute(async () => {
						throw new Error(`Failure ${i + 1}`);
					});
				} catch (err) {
					const latency = performance.now() - start;
					metrics.recordFailure(latency, err as Error, "timeout");
				}
			}

			// Circuit should now be OPEN
			expect(circuitBreaker.getState()).toBe("OPEN");

			// Subsequent requests should be rejected
			try {
				await circuitBreaker.execute(async () => ({ data: "won't reach here" }));
				expect.fail("Should have thrown CircuitOpenError");
			} catch (err) {
				expect(err).toBeInstanceOf(CircuitOpenError);
			}

			// Metrics should reflect all failures
			const snapshot = metrics.getMetrics();
			expect(snapshot.throughput.failedRequests).toBe(3);
			expect(snapshot.errors.byCategory.timeout).toBe(3);
		});

		it("should enforce rate limits and record metrics for rejected requests", () => {
			// Consume all tokens
			for (let i = 0; i < 10; i++) {
				const result = rateLimiter.consume("client-1");
				expect(result.allowed).toBe(true);
				metrics.recordSuccess(1);
			}

			// Next request should be rate limited
			const rejected = rateLimiter.consume("client-1");
			expect(rejected.allowed).toBe(false);
			expect(rejected.retryAfterMs).toBeGreaterThan(0);

			// Record the rate-limited request
			metrics.recordFailure(0, "Rate limited", "rate_limit");

			const snapshot = metrics.getMetrics();
			expect(snapshot.throughput.totalRequests).toBe(11);
			expect(snapshot.throughput.successfulRequests).toBe(10);
			expect(snapshot.throughput.failedRequests).toBe(1);
			expect(snapshot.errors.byCategory.rate_limit).toBe(1);
		});
	});

	describe("Health Check with Dependencies", () => {
		it("should report degraded when one dependency is slow", async () => {
			healthCheck.registerDependency("database", async () => ({
				status: "healthy",
				lastChecked: Date.now(),
			}));

			healthCheck.registerDependency("cache", async () => ({
				status: "degraded",
				message: "High latency",
				lastChecked: Date.now(),
			}));

			const result = await healthCheck.check();
			expect(result.status).toBe("degraded");
			expect(result.checks.database.status).toBe("healthy");
			expect(result.checks.cache.status).toBe("degraded");
		});

		it("should report unhealthy when any dependency is down", async () => {
			healthCheck.registerDependency("database", async () => ({
				status: "healthy",
				lastChecked: Date.now(),
			}));

			healthCheck.registerDependency("broker", async () => {
				throw new Error("Connection refused");
			});

			const result = await healthCheck.check();
			expect(result.status).toBe("unhealthy");
			expect(result.checks.database.status).toBe("healthy");
			expect(result.checks.broker.status).toBe("unhealthy");
			expect(result.checks.broker.message).toBe("Connection refused");
		});

		it("should cache health check results within the cache window", async () => {
			let callCount = 0;
			healthCheck.registerDependency("db", async () => {
				callCount++;
				return { status: "healthy", lastChecked: Date.now() };
			});

			// First call
			await healthCheck.check();
			expect(callCount).toBe(1);

			// Second call within cache window (100ms) should use cached result
			await healthCheck.check();
			expect(callCount).toBe(1);

			// Wait for cache to expire
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Third call should re-check
			await healthCheck.check();
			expect(callCount).toBe(2);
		});

		it("should provide liveness independent of dependency health", async () => {
			healthCheck.registerDependency("broken", async () => {
				throw new Error("Down");
			});

			// Liveness should always pass (process is alive)
			const liveness = healthCheck.liveness();
			expect(liveness.status).toBe("ok");
			expect(liveness.uptime).toBeGreaterThanOrEqual(0);

			// Readiness should reflect dependency health
			const readiness = await healthCheck.readiness();
			expect(readiness.ready).toBe(false);
			expect(readiness.status).toBe("unhealthy");
		});
	});

	describe("Circuit Breaker Recovery", () => {
		it("should recover from OPEN to CLOSED through HALF_OPEN", async () => {
			const stateChanges: string[] = [];
			circuitBreaker.on((event) => {
				if (event.type === "state_change") {
					stateChanges.push(`${event.previousState} -> ${event.state}`);
				}
			});

			// Trip the circuit
			for (let i = 0; i < 3; i++) {
				try {
					await circuitBreaker.execute(async () => {
						throw new Error("fail");
					});
				} catch {}
			}
			expect(circuitBreaker.getState()).toBe("OPEN");

			// Wait for reset timeout
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Next request transitions to HALF_OPEN
			expect(circuitBreaker.getState()).toBe("HALF_OPEN");

			// Successful requests in HALF_OPEN should close the circuit
			for (let i = 0; i < 2; i++) {
				await circuitBreaker.execute(async () => "ok");
			}

			expect(circuitBreaker.getState()).toBe("CLOSED");
			expect(stateChanges).toEqual(["CLOSED -> OPEN", "OPEN -> HALF_OPEN", "HALF_OPEN -> CLOSED"]);
		});

		it("should re-open from HALF_OPEN on failure", async () => {
			// Trip the circuit
			for (let i = 0; i < 3; i++) {
				try {
					await circuitBreaker.execute(async () => {
						throw new Error("fail");
					});
				} catch {}
			}

			// Wait for reset timeout
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Trigger HALF_OPEN check
			expect(circuitBreaker.getState()).toBe("HALF_OPEN");

			// Fail in HALF_OPEN → back to OPEN
			try {
				await circuitBreaker.execute(async () => {
					throw new Error("still broken");
				});
			} catch {}

			expect(circuitBreaker.getState()).toBe("OPEN");
		});
	});

	describe("Rate Limiter with Multiple Clients", () => {
		it("should isolate rate limits per client key", () => {
			// Client 1 uses 5 tokens
			for (let i = 0; i < 5; i++) {
				rateLimiter.consume("client-1");
			}

			// Client 2 should still have full bucket
			const client2Result = rateLimiter.consume("client-2");
			expect(client2Result.allowed).toBe(true);
			expect(client2Result.remaining).toBe(9); // 10 - 1

			// Client 1 should have 5 remaining
			const client1Result = rateLimiter.consume("client-1");
			expect(client1Result.allowed).toBe(true);
			expect(client1Result.remaining).toBe(4); // 10 - 6
		});

		it("should refill tokens over time", async () => {
			// Use all tokens
			for (let i = 0; i < 10; i++) {
				rateLimiter.consume("client-1");
			}

			// Should be rate limited
			expect(rateLimiter.consume("client-1").allowed).toBe(false);

			// Wait for refill (5 tokens/sec = 1 token every 200ms)
			await new Promise((resolve) => setTimeout(resolve, 250));

			// Should have at least 1 token now
			const result = rateLimiter.consume("client-1");
			expect(result.allowed).toBe(true);
		});

		it("should track active bucket count", () => {
			rateLimiter.consume("client-1");
			rateLimiter.consume("client-2");
			rateLimiter.consume("client-3");

			const stats = rateLimiter.getStats();
			expect(stats.activeBuckets).toBe(3);

			rateLimiter.reset("client-2");
			expect(rateLimiter.getStats().activeBuckets).toBe(2);

			rateLimiter.resetAll();
			expect(rateLimiter.getStats().activeBuckets).toBe(0);
		});
	});

	describe("Metrics Collector Comprehensive", () => {
		it("should calculate latency percentiles correctly", () => {
			// Add 100 samples with known distribution
			for (let i = 1; i <= 100; i++) {
				metrics.recordSuccess(i);
			}

			const snapshot = metrics.getMetrics();
			expect(snapshot.latency.count).toBe(100);
			expect(snapshot.latency.min).toBe(1);
			expect(snapshot.latency.max).toBe(100);
			expect(snapshot.latency.avg).toBe(50.5);
			expect(snapshot.latency.p50).toBe(50);
			expect(snapshot.latency.p95).toBe(95);
			expect(snapshot.latency.p99).toBe(99);
		});

		it("should categorize errors correctly", () => {
			metrics.recordFailure(10, new Error("timeout"), "timeout");
			metrics.recordFailure(10, new Error("timeout"), "timeout");
			metrics.recordFailure(10, new Error("connection refused"), "connection");
			metrics.recordFailure(10, "validation error", "validation");

			const snapshot = metrics.getMetrics();
			expect(snapshot.errors.total).toBe(4);
			expect(snapshot.errors.byCategory.timeout).toBe(2);
			expect(snapshot.errors.byCategory.connection).toBe(1);
			expect(snapshot.errors.byCategory.validation).toBe(1);
		});

		it("should track active connections", () => {
			metrics.incrementConnections();
			metrics.incrementConnections();
			metrics.incrementConnections();

			expect(metrics.activeConnections).toBe(3);

			metrics.decrementConnections();
			expect(metrics.activeConnections).toBe(2);

			// Should not go below 0
			metrics.decrementConnections();
			metrics.decrementConnections();
			metrics.decrementConnections();
			expect(metrics.activeConnections).toBe(0);
		});

		it("should support custom metrics", () => {
			metrics.setMetric("queue_depth", 42);
			metrics.setMetric("consumer_lag", 100);
			metrics.incrementMetric("messages_processed", 5);
			metrics.incrementMetric("messages_processed", 3);

			const snapshot = metrics.getMetrics();
			expect(snapshot.customMetrics.queue_depth).toBe(42);
			expect(snapshot.customMetrics.consumer_lag).toBe(100);
			expect(snapshot.customMetrics.messages_processed).toBe(8);
		});

		it("should reset all metrics cleanly", () => {
			metrics.recordSuccess(10);
			metrics.recordFailure(20, "error", "test");
			metrics.incrementConnections();
			metrics.setMetric("custom", 42);

			metrics.reset();

			const snapshot = metrics.getMetrics();
			expect(snapshot.throughput.totalRequests).toBe(0);
			expect(snapshot.errors.total).toBe(0);
			expect(snapshot.activeConnections).toBe(0);
			expect(Object.keys(snapshot.customMetrics)).toHaveLength(0);
			expect(snapshot.latency.count).toBe(0);
		});
	});

	describe("Circuit Breaker with Rolling Window", () => {
		it("should count failures within rolling window", async () => {
			const windowedBreaker = new CircuitBreaker({
				failureThreshold: 3,
				resetTimeoutMs: 100,
				halfOpenMaxAttempts: 1,
				failureWindowMs: 200,
			});

			try {
				// First failure
				try {
					await windowedBreaker.execute(async () => {
						throw new Error("fail 1");
					});
				} catch {}

				// Wait so the first failure ages out of the window
				await new Promise((resolve) => setTimeout(resolve, 250));

				// Two more failures (only 2 in window, threshold is 3)
				try {
					await windowedBreaker.execute(async () => {
						throw new Error("fail 2");
					});
				} catch {}

				try {
					await windowedBreaker.execute(async () => {
						throw new Error("fail 3");
					});
				} catch {}

				// Should still be CLOSED because first failure aged out of window
				expect(windowedBreaker.getState()).toBe("CLOSED");

				// One more failure tips it over (3 in window)
				try {
					await windowedBreaker.execute(async () => {
						throw new Error("fail 4");
					});
				} catch {}

				expect(windowedBreaker.getState()).toBe("OPEN");
			} finally {
				windowedBreaker.destroy();
			}
		});
	});

	describe("End-to-End Monitoring Flow", () => {
		it("should simulate a complete trigger processing pipeline", async () => {
			// Use a dedicated rate limiter with enough capacity for 20 requests
			const pipelineLimiter = new RateLimiter({ maxTokens: 25, refillRate: 10 }, 60_000);

			// Register health dependencies
			let dbHealthy = true;
			healthCheck.registerDependency("database", async () => ({
				status: dbHealthy ? "healthy" : "unhealthy",
				message: dbHealthy ? "Connected" : "Connection refused",
				lastChecked: Date.now(),
			}));

			// Simulate 20 requests: 15 success, 5 failures
			for (let i = 0; i < 20; i++) {
				// Check rate limit
				const rateCheck = pipelineLimiter.consume("global");
				if (!rateCheck.allowed) {
					metrics.recordFailure(0, "Rate limited", "rate_limit");
					continue;
				}

				const start = performance.now();
				if (i >= 15) {
					// Last 5 requests fail
					try {
						await circuitBreaker.execute(async () => {
							throw new Error(`Request ${i} failed`);
						});
					} catch (err) {
						const latency = performance.now() - start;
						if (!(err instanceof CircuitOpenError)) {
							metrics.recordFailure(latency, err as Error, "backend");
						} else {
							metrics.recordFailure(0, "Circuit open", "circuit_open");
						}
					}
				} else {
					// First 15 succeed
					const result = await circuitBreaker.execute(async () => {
						await new Promise((resolve) => setTimeout(resolve, 1));
						return { processed: true };
					});
					const latency = performance.now() - start;
					metrics.recordSuccess(latency);
				}
			}

			// Verify final state
			const snapshot = metrics.getMetrics();
			expect(snapshot.throughput.totalRequests).toBe(20);
			expect(snapshot.throughput.successfulRequests).toBe(15);

			// Circuit breaker should be OPEN after 3+ failures
			expect(circuitBreaker.getState()).toBe("OPEN");

			// Health check should still work independently
			const health = await healthCheck.check();
			expect(health.status).toBe("healthy");

			// Simulate database going down
			dbHealthy = false;
			// Wait for cache to expire
			await new Promise((resolve) => setTimeout(resolve, 150));
			const degradedHealth = await healthCheck.check();
			expect(degradedHealth.status).toBe("unhealthy");

			// Readiness should fail
			const readiness = await healthCheck.readiness();
			expect(readiness.ready).toBe(false);

			// Liveness should still pass
			const liveness = healthCheck.liveness();
			expect(liveness.status).toBe("ok");

			pipelineLimiter.destroy();
		});

		it("should handle concurrent requests with rate limiting and metrics", async () => {
			const concurrentLimiter = new RateLimiter({ maxTokens: 5, refillRate: 10 }, 60_000);

			try {
				// Fire 10 concurrent requests
				const results = await Promise.all(
					Array.from({ length: 10 }, async (_, i) => {
						const rateResult = concurrentLimiter.consume("concurrent-test");
						if (!rateResult.allowed) {
							metrics.recordFailure(0, "Rate limited", "rate_limit");
							return { success: false, reason: "rate_limited" };
						}

						metrics.recordSuccess(i + 1);
						return { success: true };
					}),
				);

				const successful = results.filter((r) => r.success).length;
				const rateLimited = results.filter((r) => !r.success).length;

				// With 5 token bucket, first 5 should succeed, rest rate limited
				expect(successful).toBe(5);
				expect(rateLimited).toBe(5);

				const snapshot = metrics.getMetrics();
				expect(snapshot.throughput.totalRequests).toBe(10);
				expect(snapshot.throughput.successfulRequests).toBe(5);
				expect(snapshot.throughput.failedRequests).toBe(5);
				expect(snapshot.errors.byCategory.rate_limit).toBe(5);
			} finally {
				concurrentLimiter.destroy();
			}
		});
	});

	describe("Circuit Breaker Event Listeners", () => {
		it("should emit events for all state transitions and actions", async () => {
			const events: Array<{ type: string; state: string }> = [];
			circuitBreaker.on((event) => {
				events.push({ type: event.type, state: event.state });
			});

			// Cause failures
			for (let i = 0; i < 3; i++) {
				try {
					await circuitBreaker.execute(async () => {
						throw new Error("fail");
					});
				} catch {}
			}

			// Try rejected request
			try {
				await circuitBreaker.execute(async () => "nope");
			} catch {}

			const failureEvents = events.filter((e) => e.type === "failure");
			const stateChangeEvents = events.filter((e) => e.type === "state_change");
			const rejectedEvents = events.filter((e) => e.type === "request_rejected");

			expect(failureEvents).toHaveLength(3);
			expect(stateChangeEvents).toHaveLength(1);
			expect(stateChangeEvents[0].state).toBe("OPEN");
			expect(rejectedEvents).toHaveLength(1);
		});

		it("should handle listener removal correctly", async () => {
			let callCount = 0;
			const listener = () => {
				callCount++;
			};

			circuitBreaker.on(listener);

			try {
				await circuitBreaker.execute(async () => {
					throw new Error("fail");
				});
			} catch {}

			expect(callCount).toBe(1); // failure event

			circuitBreaker.off(listener);

			try {
				await circuitBreaker.execute(async () => {
					throw new Error("fail");
				});
			} catch {}

			expect(callCount).toBe(1); // no more events
		});
	});

	describe("Health Check Dynamic Dependencies", () => {
		it("should support adding and removing dependencies at runtime", async () => {
			healthCheck.registerDependency("service-a", async () => ({
				status: "healthy",
				lastChecked: Date.now(),
			}));

			let result = await healthCheck.check();
			expect(Object.keys(result.checks)).toEqual(["service-a"]);

			healthCheck.registerDependency("service-b", async () => ({
				status: "healthy",
				lastChecked: Date.now(),
			}));

			result = await healthCheck.check();
			expect(Object.keys(result.checks).sort()).toEqual(["service-a", "service-b"]);

			healthCheck.removeDependency("service-a");

			// Wait for cache to expire
			await new Promise((resolve) => setTimeout(resolve, 150));

			result = await healthCheck.check();
			expect(Object.keys(result.checks)).toEqual(["service-b"]);
		});
	});
});
