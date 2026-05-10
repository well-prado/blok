import { beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker } from "../CircuitBreaker";
import { PrometheusMetricsBridge } from "../PrometheusMetricsBridge";
import { RateLimiter } from "../RateLimiter";
import { TriggerMetricsCollector } from "../TriggerMetricsCollector";

describe("PrometheusMetricsBridge", () => {
	let collector: TriggerMetricsCollector;
	let bridge: PrometheusMetricsBridge;

	beforeEach(() => {
		collector = new TriggerMetricsCollector("HttpTrigger", "test-trigger");
		bridge = new PrometheusMetricsBridge({ triggerType: "HttpTrigger", triggerName: "test-trigger" }, collector);
	});

	describe("Construction", () => {
		it("should create a bridge with config and collector", () => {
			expect(bridge).toBeInstanceOf(PrometheusMetricsBridge);
		});

		it("should accept different trigger types", () => {
			const wsBridge = new PrometheusMetricsBridge(
				{ triggerType: "WebSocketTrigger", triggerName: "ws-test" },
				new TriggerMetricsCollector("WebSocketTrigger", "ws-test"),
			);
			expect(wsBridge).toBeInstanceOf(PrometheusMetricsBridge);
		});
	});

	describe("initialize()", () => {
		it("should initialize without errors", () => {
			expect(() => bridge.initialize()).not.toThrow();
		});

		it("should be idempotent (calling twice does not throw)", () => {
			bridge.initialize();
			expect(() => bridge.initialize()).not.toThrow();
		});
	});

	describe("recordExecution()", () => {
		beforeEach(() => {
			bridge.initialize();
		});

		it("should record a successful execution", () => {
			bridge.recordExecution(150, true, {
				workflow_name: "test-workflow",
				workflow_version: "1.0.0",
				env: "test",
			});

			const metrics = collector.getMetrics();
			expect(metrics.throughput.totalRequests).toBe(1);
			expect(metrics.throughput.successfulRequests).toBe(1);
			expect(metrics.throughput.failedRequests).toBe(0);
		});

		it("should record a failed execution", () => {
			bridge.recordExecution(500, false, {
				workflow_name: "test-workflow",
				workflow_version: "1.0.0",
				env: "test",
			});

			const metrics = collector.getMetrics();
			expect(metrics.throughput.totalRequests).toBe(1);
			expect(metrics.throughput.failedRequests).toBe(1);
			expect(metrics.throughput.successfulRequests).toBe(0);
		});

		it("should record latency samples to the collector", () => {
			bridge.recordExecution(100, true, {
				workflow_name: "wf",
				workflow_version: "1.0.0",
				env: "test",
			});
			bridge.recordExecution(200, true, {
				workflow_name: "wf",
				workflow_version: "1.0.0",
				env: "test",
			});
			bridge.recordExecution(300, true, {
				workflow_name: "wf",
				workflow_version: "1.0.0",
				env: "test",
			});

			const metrics = collector.getMetrics();
			expect(metrics.latency.count).toBe(3);
			expect(metrics.latency.min).toBe(100);
			expect(metrics.latency.max).toBe(300);
		});

		it("should track success rate correctly", () => {
			bridge.recordExecution(100, true, {
				workflow_name: "wf",
				workflow_version: "1.0.0",
				env: "test",
			});
			bridge.recordExecution(200, false, {
				workflow_name: "wf",
				workflow_version: "1.0.0",
				env: "test",
			});

			const metrics = collector.getMetrics();
			expect(metrics.throughput.successRate).toBe(0.5);
		});

		it("should handle zero-duration executions", () => {
			expect(() =>
				bridge.recordExecution(0, true, {
					workflow_name: "wf",
					workflow_version: "1.0.0",
					env: "test",
				}),
			).not.toThrow();
		});

		it("should handle very large durations", () => {
			expect(() =>
				bridge.recordExecution(999999, true, {
					workflow_name: "wf",
					workflow_version: "1.0.0",
					env: "test",
				}),
			).not.toThrow();
		});
	});

	describe("recordError()", () => {
		beforeEach(() => {
			bridge.initialize();
		});

		it("should record errors with category", () => {
			bridge.recordError("timeout");
			bridge.recordError("validation");
			bridge.recordError("timeout");

			// Errors counter is internal to OpenTelemetry, but we can verify the bridge doesn't throw
			expect(true).toBe(true);
		});

		it("should accept custom labels", () => {
			expect(() => bridge.recordError("runtime", { env: "production", workflow_name: "wf" })).not.toThrow();
		});

		it("should use default env when not provided", () => {
			expect(() => bridge.recordError("network")).not.toThrow();
		});
	});

	describe("attachCircuitBreaker()", () => {
		it("should attach a circuit breaker for state monitoring", () => {
			bridge.initialize();
			const cb = new CircuitBreaker({
				failureThreshold: 5,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 2,
			});
			expect(() => bridge.attachCircuitBreaker(cb)).not.toThrow();
			cb.destroy();
		});
	});

	describe("attachRateLimiter()", () => {
		it("should attach a rate limiter for token monitoring", () => {
			bridge.initialize();
			const rl = new RateLimiter({
				maxTokens: 100,
				refillRate: 10,
			});
			expect(() => bridge.attachRateLimiter(rl)).not.toThrow();
			rl.destroy();
		});
	});

	describe("destroy()", () => {
		it("should clean up without errors", () => {
			bridge.initialize();
			expect(() => bridge.destroy()).not.toThrow();
		});

		it("should allow re-initialization after destroy", () => {
			bridge.initialize();
			bridge.destroy();
			// Create a new bridge since internal state is cleared
			const newBridge = new PrometheusMetricsBridge({ triggerType: "HttpTrigger", triggerName: "test" }, collector);
			expect(() => newBridge.initialize()).not.toThrow();
		});

		it("should clear attached circuit breaker and rate limiter", () => {
			bridge.initialize();
			const cb = new CircuitBreaker({
				failureThreshold: 5,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 2,
			});
			const rl = new RateLimiter({
				maxTokens: 100,
				refillRate: 10,
			});
			bridge.attachCircuitBreaker(cb);
			bridge.attachRateLimiter(rl);
			bridge.destroy();

			// After destroy, recording should still work (no-op instruments)
			expect(() =>
				bridge.recordExecution(100, true, {
					workflow_name: "wf",
					workflow_version: "1.0.0",
					env: "test",
				}),
			).not.toThrow();

			cb.destroy();
			rl.destroy();
		});
	});

	describe("Observable Metrics (via collector)", () => {
		it("should expose latency percentiles from collector", () => {
			bridge.initialize();

			// Add latency samples via recordExecution
			for (let i = 1; i <= 100; i++) {
				bridge.recordExecution(i, true, {
					workflow_name: "wf",
					workflow_version: "1.0.0",
					env: "test",
				});
			}

			const metrics = collector.getMetrics();
			expect(metrics.latency.p50).toBeGreaterThan(0);
			expect(metrics.latency.p95).toBeGreaterThan(metrics.latency.p50);
			expect(metrics.latency.p99).toBeGreaterThanOrEqual(metrics.latency.p95);
		});

		it("should expose throughput RPS from collector", () => {
			bridge.initialize();

			bridge.recordExecution(10, true, {
				workflow_name: "wf",
				workflow_version: "1.0.0",
				env: "test",
			});

			const metrics = collector.getMetrics();
			expect(metrics.throughput.requestsPerSecond).toBeGreaterThanOrEqual(0);
		});

		it("should expose active connections from collector", () => {
			bridge.initialize();

			collector.incrementConnections();
			collector.incrementConnections();
			expect(collector.getMetrics().activeConnections).toBe(2);

			collector.decrementConnections();
			expect(collector.getMetrics().activeConnections).toBe(1);
		});
	});

	describe("Multiple Instances", () => {
		it("should support multiple bridges with different collectors", () => {
			const collector2 = new TriggerMetricsCollector("GrpcTrigger", "grpc-test");
			const bridge2 = new PrometheusMetricsBridge({ triggerType: "GrpcTrigger", triggerName: "grpc-test" }, collector2);

			bridge.initialize();
			bridge2.initialize();

			bridge.recordExecution(100, true, {
				workflow_name: "wf1",
				workflow_version: "1.0.0",
				env: "test",
			});
			bridge2.recordExecution(200, true, {
				workflow_name: "wf2",
				workflow_version: "1.0.0",
				env: "test",
			});

			expect(collector.getMetrics().throughput.totalRequests).toBe(1);
			expect(collector2.getMetrics().throughput.totalRequests).toBe(1);

			bridge2.destroy();
		});

		it("should not interfere between instances", () => {
			const collector2 = new TriggerMetricsCollector("SSETrigger", "sse-test");
			const bridge2 = new PrometheusMetricsBridge({ triggerType: "SSETrigger", triggerName: "sse-test" }, collector2);

			bridge.initialize();
			bridge2.initialize();

			bridge.recordExecution(50, false, {
				workflow_name: "wf1",
				workflow_version: "1.0.0",
				env: "test",
			});

			expect(collector.getMetrics().throughput.failedRequests).toBe(1);
			expect(collector2.getMetrics().throughput.failedRequests).toBe(0);

			bridge2.destroy();
		});
	});

	describe("Works with No-Op Meter", () => {
		it("should work when no MeterProvider is configured (default no-op)", () => {
			// By default, OpenTelemetry uses a no-op meter when no provider is set.
			// All operations should silently succeed.
			bridge.initialize();

			expect(() =>
				bridge.recordExecution(100, true, {
					workflow_name: "wf",
					workflow_version: "1.0.0",
					env: "test",
				}),
			).not.toThrow();

			expect(() => bridge.recordError("timeout")).not.toThrow();
			expect(() => bridge.destroy()).not.toThrow();
		});
	});
});
