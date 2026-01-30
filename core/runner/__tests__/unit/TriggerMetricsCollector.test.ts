import { beforeEach, describe, expect, it } from "vitest";
import { TriggerMetricsCollector } from "../../src/monitoring/TriggerMetricsCollector";

describe("TriggerMetricsCollector", () => {
	let collector: TriggerMetricsCollector;

	beforeEach(() => {
		collector = new TriggerMetricsCollector("HttpTrigger", "my-workflow");
	});

	describe("initialization", () => {
		it("should initialize with trigger metadata", () => {
			const metrics = collector.getMetrics();
			expect(metrics.triggerType).toBe("HttpTrigger");
			expect(metrics.triggerName).toBe("my-workflow");
			expect(metrics.startTime).toBeGreaterThan(0);
		});

		it("should start with zero counts", () => {
			const metrics = collector.getMetrics();
			expect(metrics.throughput.totalRequests).toBe(0);
			expect(metrics.throughput.successfulRequests).toBe(0);
			expect(metrics.throughput.failedRequests).toBe(0);
			expect(metrics.errors.total).toBe(0);
			expect(metrics.activeConnections).toBe(0);
		});
	});

	describe("recordSuccess", () => {
		it("should track successful requests", () => {
			collector.recordSuccess(10);
			collector.recordSuccess(20);
			collector.recordSuccess(30);

			const metrics = collector.getMetrics();
			expect(metrics.throughput.totalRequests).toBe(3);
			expect(metrics.throughput.successfulRequests).toBe(3);
			expect(metrics.throughput.failedRequests).toBe(0);
			expect(metrics.throughput.successRate).toBe(1);
		});

		it("should calculate latency stats from successes", () => {
			collector.recordSuccess(10);
			collector.recordSuccess(20);
			collector.recordSuccess(30);

			const latency = collector.getMetrics().latency;
			expect(latency.count).toBe(3);
			expect(latency.min).toBe(10);
			expect(latency.max).toBe(30);
			expect(latency.avg).toBe(20);
		});
	});

	describe("recordFailure", () => {
		it("should track failed requests", () => {
			collector.recordFailure(50, "Connection timeout", "timeout");

			const metrics = collector.getMetrics();
			expect(metrics.throughput.totalRequests).toBe(1);
			expect(metrics.throughput.failedRequests).toBe(1);
			expect(metrics.throughput.successRate).toBe(0);
		});

		it("should categorize errors", () => {
			collector.recordFailure(10, "timeout", "timeout");
			collector.recordFailure(20, "timeout", "timeout");
			collector.recordFailure(30, "bad request", "validation");

			const errors = collector.getMetrics().errors;
			expect(errors.total).toBe(3);
			expect(errors.byCategory.timeout).toBe(2);
			expect(errors.byCategory.validation).toBe(1);
		});

		it("should track recent errors", () => {
			collector.recordFailure(10, new Error("Something broke"), "runtime");

			const errors = collector.getMetrics().errors;
			expect(errors.recentErrors).toHaveLength(1);
			expect(errors.recentErrors[0].message).toBe("Something broke");
			expect(errors.recentErrors[0].category).toBe("runtime");
			expect(errors.recentErrors[0].timestamp).toBeGreaterThan(0);
		});

		it("should limit recent errors to max 50", () => {
			for (let i = 0; i < 60; i++) {
				collector.recordFailure(10, `Error ${i}`, "test");
			}

			const errors = collector.getMetrics().errors;
			expect(errors.recentErrors.length).toBeLessThanOrEqual(50);
		});
	});

	describe("latency percentiles", () => {
		it("should calculate p50 correctly", () => {
			for (let i = 1; i <= 100; i++) {
				collector.recordSuccess(i);
			}

			const latency = collector.getMetrics().latency;
			expect(latency.p50).toBe(50);
		});

		it("should calculate p95 correctly", () => {
			for (let i = 1; i <= 100; i++) {
				collector.recordSuccess(i);
			}

			const latency = collector.getMetrics().latency;
			expect(latency.p95).toBe(95);
		});

		it("should calculate p99 correctly", () => {
			for (let i = 1; i <= 100; i++) {
				collector.recordSuccess(i);
			}

			const latency = collector.getMetrics().latency;
			expect(latency.p99).toBe(99);
		});

		it("should return zeros when no samples", () => {
			const latency = collector.getMetrics().latency;
			expect(latency.count).toBe(0);
			expect(latency.min).toBe(0);
			expect(latency.max).toBe(0);
			expect(latency.p50).toBe(0);
			expect(latency.p95).toBe(0);
			expect(latency.p99).toBe(0);
		});
	});

	describe("connection tracking", () => {
		it("should track active connections", () => {
			collector.incrementConnections();
			collector.incrementConnections();
			expect(collector.activeConnections).toBe(2);

			collector.decrementConnections();
			expect(collector.activeConnections).toBe(1);
		});

		it("should not go below zero", () => {
			collector.decrementConnections();
			expect(collector.activeConnections).toBe(0);
		});

		it("should include connections in metrics", () => {
			collector.incrementConnections();
			collector.incrementConnections();
			collector.incrementConnections();

			const metrics = collector.getMetrics();
			expect(metrics.activeConnections).toBe(3);
		});
	});

	describe("custom metrics", () => {
		it("should set custom metrics", () => {
			collector.setMetric("queue_depth", 42);

			const metrics = collector.getMetrics();
			expect(metrics.customMetrics.queue_depth).toBe(42);
		});

		it("should increment custom metrics", () => {
			collector.incrementMetric("messages_processed");
			collector.incrementMetric("messages_processed");
			collector.incrementMetric("messages_processed", 5);

			const metrics = collector.getMetrics();
			expect(metrics.customMetrics.messages_processed).toBe(7);
		});

		it("should handle incrementing non-existent metric", () => {
			collector.incrementMetric("new_metric", 3);

			const metrics = collector.getMetrics();
			expect(metrics.customMetrics.new_metric).toBe(3);
		});
	});

	describe("throughput", () => {
		it("should calculate success rate", () => {
			collector.recordSuccess(10);
			collector.recordSuccess(10);
			collector.recordFailure(10, "err", "test");

			const throughput = collector.getMetrics().throughput;
			expect(throughput.successRate).toBeCloseTo(0.6667, 3);
		});

		it("should calculate requests per second", () => {
			for (let i = 0; i < 10; i++) {
				collector.recordSuccess(1);
			}

			const throughput = collector.getMetrics().throughput;
			expect(throughput.requestsPerSecond).toBeGreaterThan(0);
		});

		it("should return 1 success rate with no requests", () => {
			const throughput = collector.getMetrics().throughput;
			expect(throughput.successRate).toBe(1);
		});
	});

	describe("reset", () => {
		it("should reset all metrics", () => {
			collector.recordSuccess(10);
			collector.recordFailure(20, "err", "test");
			collector.incrementConnections();
			collector.setMetric("custom", 5);

			collector.reset();

			const metrics = collector.getMetrics();
			expect(metrics.throughput.totalRequests).toBe(0);
			expect(metrics.errors.total).toBe(0);
			expect(metrics.latency.count).toBe(0);
			expect(metrics.activeConnections).toBe(0);
			expect(Object.keys(metrics.customMetrics)).toHaveLength(0);
		});
	});
});
