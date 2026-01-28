/**
 * RuntimeMetricsDashboard - Aggregated Execution Metrics for Blok Runtimes
 *
 * Collects and aggregates execution metrics across all runtimes with
 * latency percentiles, throughput tracking, and resource monitoring
 * following the same patterns as TriggerMetricsCollector.
 */

import type { RuntimeKind, ExecutionResult } from "../adapters/RuntimeAdapter";

export interface LatencyPercentiles {
	count: number;
	min: number;
	max: number;
	avg: number;
	p50: number;
	p95: number;
	p99: number;
}

export interface ThroughputMetrics {
	requestsPerSecond: number;
	peakRps: number;
	windowSizeMs: number;
}

export interface ResourceMetrics {
	avgCpuMs: number;
	avgMemoryBytes: number;
	peakMemoryBytes: number;
}

export interface RuntimeExecutionMetrics {
	runtime: RuntimeKind;
	totalExecutions: number;
	successfulExecutions: number;
	failedExecutions: number;
	successRate: number;
	latency: LatencyPercentiles;
	throughput: ThroughputMetrics;
	resourceUsage: ResourceMetrics;
	lastExecution: number;
}

export interface AggregateMetrics {
	totalExecutions: number;
	totalSuccess: number;
	totalFailures: number;
	overallSuccessRate: number;
	avgLatencyMs: number;
	activeRuntimes: number;
	busiestRuntime: RuntimeKind | null;
	slowestRuntime: RuntimeKind | null;
}

export interface DashboardSnapshot {
	timestamp: number;
	runtimes: RuntimeExecutionMetrics[];
	aggregate: AggregateMetrics;
}

const MAX_LATENCY_SAMPLES = 10_000;
const RPS_WINDOW_MS = 60_000; // 1 minute window for RPS calculation

/**
 * Internal data structure holding raw metric samples for a single runtime.
 */
interface RuntimeMetricsData {
	latencySamples: number[];
	requestTimestamps: number[];
	cpuSamples: number[];
	memorySamples: number[];
	peakMemoryBytes: number;
	successCount: number;
	failureCount: number;
	peakRps: number;
	lastExecution: number;
}

function createEmptyMetricsData(): RuntimeMetricsData {
	return {
		latencySamples: [],
		requestTimestamps: [],
		cpuSamples: [],
		memorySamples: [],
		peakMemoryBytes: 0,
		successCount: 0,
		failureCount: 0,
		peakRps: 0,
		lastExecution: 0,
	};
}

export class RuntimeMetricsDashboard {
	private metrics: Map<RuntimeKind, RuntimeMetricsData> = new Map();

	/**
	 * Record an execution result for a runtime.
	 */
	recordExecution(runtime: RuntimeKind, result: ExecutionResult): void {
		let data = this.metrics.get(runtime);
		if (!data) {
			data = createEmptyMetricsData();
			this.metrics.set(runtime, data);
		}

		const now = Date.now();
		data.lastExecution = now;

		// Track success/failure
		if (result.success) {
			data.successCount++;
		} else {
			data.failureCount++;
		}

		// Record latency sample from execution metrics
		if (result.metrics?.duration_ms !== undefined) {
			data.latencySamples.push(result.metrics.duration_ms);
			if (data.latencySamples.length > MAX_LATENCY_SAMPLES) {
				// Keep only the most recent half
				data.latencySamples = data.latencySamples.slice(-MAX_LATENCY_SAMPLES / 2);
			}
		}

		// Record resource usage samples
		if (result.metrics?.cpu_ms !== undefined) {
			data.cpuSamples.push(result.metrics.cpu_ms);
			if (data.cpuSamples.length > MAX_LATENCY_SAMPLES) {
				data.cpuSamples = data.cpuSamples.slice(-MAX_LATENCY_SAMPLES / 2);
			}
		}

		if (result.metrics?.memory_bytes !== undefined) {
			data.memorySamples.push(result.metrics.memory_bytes);
			if (result.metrics.memory_bytes > data.peakMemoryBytes) {
				data.peakMemoryBytes = result.metrics.memory_bytes;
			}
			if (data.memorySamples.length > MAX_LATENCY_SAMPLES) {
				data.memorySamples = data.memorySamples.slice(-MAX_LATENCY_SAMPLES / 2);
			}
		}

		// Record request timestamp for RPS calculation
		data.requestTimestamps.push(now);
		const cutoff = now - RPS_WINDOW_MS;
		while (data.requestTimestamps.length > 0 && data.requestTimestamps[0] < cutoff) {
			data.requestTimestamps.shift();
		}

		// Update peak RPS
		const currentRps = data.requestTimestamps.length / (RPS_WINDOW_MS / 1000);
		if (currentRps > data.peakRps) {
			data.peakRps = currentRps;
		}
	}

	/**
	 * Get computed metrics for a specific runtime.
	 */
	getMetrics(runtime: RuntimeKind): RuntimeExecutionMetrics | undefined {
		const data = this.metrics.get(runtime);
		if (!data) {
			return undefined;
		}
		return this.computeMetrics(runtime, data);
	}

	/**
	 * Get computed metrics for all tracked runtimes.
	 */
	getAllMetrics(): RuntimeExecutionMetrics[] {
		const result: RuntimeExecutionMetrics[] = [];
		this.metrics.forEach((data, runtime) => {
			result.push(this.computeMetrics(runtime, data));
		});
		return result;
	}

	/**
	 * Get a full dashboard snapshot with per-runtime and aggregate metrics.
	 */
	getSnapshot(): DashboardSnapshot {
		const runtimes = this.getAllMetrics();
		const aggregate = this.computeAggregate(runtimes);

		return {
			timestamp: Date.now(),
			runtimes,
			aggregate,
		};
	}

	/**
	 * Get top runtimes ranked by a specific metric.
	 */
	getTopRuntimes(
		by: "executions" | "successRate" | "latency",
		limit = 10,
	): RuntimeExecutionMetrics[] {
		const all = this.getAllMetrics();

		switch (by) {
			case "executions":
				all.sort((a, b) => b.totalExecutions - a.totalExecutions);
				break;
			case "successRate":
				all.sort((a, b) => b.successRate - a.successRate);
				break;
			case "latency":
				// Lower latency is better, sort ascending
				all.sort((a, b) => a.latency.avg - b.latency.avg);
				break;
		}

		return all.slice(0, limit);
	}

	/**
	 * Get execution count trend over time windows for a specific runtime.
	 *
	 * @param runtime - The runtime to get trends for
	 * @param intervalMs - Size of each time window in ms (default: 60000 = 1 min)
	 * @param windowCount - Number of time windows to return (default: 10)
	 * @returns Array of execution counts, one per time window (oldest first)
	 */
	getExecutionTrend(
		runtime: RuntimeKind,
		intervalMs = 60_000,
		windowCount = 10,
	): number[] {
		const data = this.metrics.get(runtime);
		if (!data) {
			return new Array(windowCount).fill(0);
		}

		const now = Date.now();
		const trend: number[] = new Array(windowCount).fill(0);

		for (const timestamp of data.requestTimestamps) {
			const age = now - timestamp;
			const windowIndex = windowCount - 1 - Math.floor(age / intervalMs);
			if (windowIndex >= 0 && windowIndex < windowCount) {
				trend[windowIndex]++;
			}
		}

		return trend;
	}

	/**
	 * Clear all metrics for all runtimes.
	 */
	reset(): void {
		this.metrics.clear();
	}

	/**
	 * Clear metrics for a specific runtime.
	 */
	resetRuntime(runtime: RuntimeKind): void {
		this.metrics.delete(runtime);
	}

	/**
	 * Compute RuntimeExecutionMetrics from raw data for a single runtime.
	 */
	private computeMetrics(runtime: RuntimeKind, data: RuntimeMetricsData): RuntimeExecutionMetrics {
		const totalExecutions = data.successCount + data.failureCount;
		const successRate = totalExecutions > 0 ? data.successCount / totalExecutions : 1;

		// Prune old request timestamps before computing throughput
		const now = Date.now();
		const cutoff = now - RPS_WINDOW_MS;
		while (data.requestTimestamps.length > 0 && data.requestTimestamps[0] < cutoff) {
			data.requestTimestamps.shift();
		}

		const currentRps = data.requestTimestamps.length / (RPS_WINDOW_MS / 1000);

		return {
			runtime,
			totalExecutions,
			successfulExecutions: data.successCount,
			failedExecutions: data.failureCount,
			successRate,
			latency: this.computeLatencyPercentiles(data.latencySamples),
			throughput: {
				requestsPerSecond: currentRps,
				peakRps: data.peakRps,
				windowSizeMs: RPS_WINDOW_MS,
			},
			resourceUsage: this.computeResourceMetrics(data),
			lastExecution: data.lastExecution,
		};
	}

	/**
	 * Compute latency percentiles from a samples array.
	 */
	private computeLatencyPercentiles(samples: number[]): LatencyPercentiles {
		if (samples.length === 0) {
			return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
		}

		const sorted = [...samples].sort((a, b) => a - b);
		const count = sorted.length;
		const sum = sorted.reduce((a, b) => a + b, 0);

		return {
			count,
			min: sorted[0],
			max: sorted[count - 1],
			avg: sum / count,
			p50: this.percentile(sorted, 50),
			p95: this.percentile(sorted, 95),
			p99: this.percentile(sorted, 99),
		};
	}

	/**
	 * Compute the p-th percentile from a pre-sorted array.
	 */
	private percentile(sorted: number[], p: number): number {
		if (sorted.length === 0) return 0;
		const index = Math.ceil((p / 100) * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
	}

	/**
	 * Compute resource usage metrics from raw data.
	 */
	private computeResourceMetrics(data: RuntimeMetricsData): ResourceMetrics {
		const avgCpuMs =
			data.cpuSamples.length > 0
				? data.cpuSamples.reduce((a, b) => a + b, 0) / data.cpuSamples.length
				: 0;

		const avgMemoryBytes =
			data.memorySamples.length > 0
				? data.memorySamples.reduce((a, b) => a + b, 0) / data.memorySamples.length
				: 0;

		return {
			avgCpuMs,
			avgMemoryBytes,
			peakMemoryBytes: data.peakMemoryBytes,
		};
	}

	/**
	 * Compute aggregate metrics across all runtimes.
	 */
	private computeAggregate(runtimes: RuntimeExecutionMetrics[]): AggregateMetrics {
		if (runtimes.length === 0) {
			return {
				totalExecutions: 0,
				totalSuccess: 0,
				totalFailures: 0,
				overallSuccessRate: 1,
				avgLatencyMs: 0,
				activeRuntimes: 0,
				busiestRuntime: null,
				slowestRuntime: null,
			};
		}

		let totalExecutions = 0;
		let totalSuccess = 0;
		let totalFailures = 0;
		let latencySum = 0;
		let latencyCount = 0;
		let busiestRuntime: RuntimeKind | null = null;
		let busiestCount = -1;
		let slowestRuntime: RuntimeKind | null = null;
		let slowestLatency = -1;

		for (const m of runtimes) {
			totalExecutions += m.totalExecutions;
			totalSuccess += m.successfulExecutions;
			totalFailures += m.failedExecutions;

			if (m.latency.count > 0) {
				latencySum += m.latency.avg * m.latency.count;
				latencyCount += m.latency.count;
			}

			if (m.totalExecutions > busiestCount) {
				busiestCount = m.totalExecutions;
				busiestRuntime = m.runtime;
			}

			if (m.latency.avg > slowestLatency && m.latency.count > 0) {
				slowestLatency = m.latency.avg;
				slowestRuntime = m.runtime;
			}
		}

		const overallSuccessRate = totalExecutions > 0 ? totalSuccess / totalExecutions : 1;
		const avgLatencyMs = latencyCount > 0 ? latencySum / latencyCount : 0;
		const activeRuntimes = runtimes.filter((m) => m.totalExecutions > 0).length;

		return {
			totalExecutions,
			totalSuccess,
			totalFailures,
			overallSuccessRate,
			avgLatencyMs,
			activeRuntimes,
			busiestRuntime,
			slowestRuntime,
		};
	}
}
