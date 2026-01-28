/**
 * TriggerMetricsCollector - Enhanced Metrics for Blok Triggers
 *
 * Centralized metrics collection with latency percentiles,
 * error categorization, throughput tracking, and resource monitoring.
 */

export interface LatencyStats {
	count: number;
	min: number;
	max: number;
	avg: number;
	p50: number;
	p95: number;
	p99: number;
}

export interface ErrorStats {
	total: number;
	byCategory: Record<string, number>;
	recentErrors: Array<{ message: string; category: string; timestamp: number }>;
}

export interface ThroughputStats {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	requestsPerSecond: number;
	successRate: number;
}

export interface TriggerMetrics {
	triggerType: string;
	triggerName: string;
	startTime: number;
	latency: LatencyStats;
	errors: ErrorStats;
	throughput: ThroughputStats;
	activeConnections: number;
	customMetrics: Record<string, number>;
}

const MAX_RECENT_ERRORS = 50;
const MAX_LATENCY_SAMPLES = 10_000;

export class TriggerMetricsCollector {
	private triggerType: string;
	private triggerName: string;
	private startTime: number;
	private latencySamples: number[] = [];
	private errorCount = 0;
	private errorsByCategory: Map<string, number> = new Map();
	private recentErrors: Array<{ message: string; category: string; timestamp: number }> = [];
	private totalRequests = 0;
	private successfulRequests = 0;
	private failedRequests = 0;
	private _activeConnections = 0;
	private customMetrics: Map<string, number> = new Map();
	private requestTimestamps: number[] = [];
	private rpsWindow = 60_000; // 1 minute window for RPS calculation

	constructor(triggerType: string, triggerName: string) {
		this.triggerType = triggerType;
		this.triggerName = triggerName;
		this.startTime = Date.now();
	}

	/**
	 * Record a successful request with its latency.
	 */
	recordSuccess(latencyMs: number): void {
		this.totalRequests++;
		this.successfulRequests++;
		this.addLatencySample(latencyMs);
		this.recordRequestTimestamp();
	}

	/**
	 * Record a failed request with error details.
	 */
	recordFailure(latencyMs: number, error: Error | string, category = "unknown"): void {
		this.totalRequests++;
		this.failedRequests++;
		this.errorCount++;
		this.addLatencySample(latencyMs);
		this.recordRequestTimestamp();

		const count = this.errorsByCategory.get(category) || 0;
		this.errorsByCategory.set(category, count + 1);

		this.recentErrors.push({
			message: typeof error === "string" ? error : error.message,
			category,
			timestamp: Date.now(),
		});

		if (this.recentErrors.length > MAX_RECENT_ERRORS) {
			this.recentErrors.shift();
		}
	}

	/**
	 * Track active connections (for WebSocket, SSE, etc.).
	 */
	incrementConnections(): void {
		this._activeConnections++;
	}

	decrementConnections(): void {
		this._activeConnections = Math.max(0, this._activeConnections - 1);
	}

	get activeConnections(): number {
		return this._activeConnections;
	}

	/**
	 * Set a custom metric value.
	 */
	setMetric(name: string, value: number): void {
		this.customMetrics.set(name, value);
	}

	/**
	 * Increment a custom metric.
	 */
	incrementMetric(name: string, amount = 1): void {
		const current = this.customMetrics.get(name) || 0;
		this.customMetrics.set(name, current + amount);
	}

	/**
	 * Get a snapshot of all metrics.
	 */
	getMetrics(): TriggerMetrics {
		return {
			triggerType: this.triggerType,
			triggerName: this.triggerName,
			startTime: this.startTime,
			latency: this.getLatencyStats(),
			errors: this.getErrorStats(),
			throughput: this.getThroughputStats(),
			activeConnections: this._activeConnections,
			customMetrics: Object.fromEntries(this.customMetrics),
		};
	}

	/**
	 * Reset all collected metrics.
	 */
	reset(): void {
		this.latencySamples = [];
		this.errorCount = 0;
		this.errorsByCategory.clear();
		this.recentErrors = [];
		this.totalRequests = 0;
		this.successfulRequests = 0;
		this.failedRequests = 0;
		this._activeConnections = 0;
		this.customMetrics.clear();
		this.requestTimestamps = [];
		this.startTime = Date.now();
	}

	private addLatencySample(ms: number): void {
		this.latencySamples.push(ms);
		if (this.latencySamples.length > MAX_LATENCY_SAMPLES) {
			// Keep only the most recent half
			this.latencySamples = this.latencySamples.slice(-MAX_LATENCY_SAMPLES / 2);
		}
	}

	private recordRequestTimestamp(): void {
		const now = Date.now();
		this.requestTimestamps.push(now);
		// Prune timestamps outside the RPS window
		const cutoff = now - this.rpsWindow;
		while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
			this.requestTimestamps.shift();
		}
	}

	private getLatencyStats(): LatencyStats {
		if (this.latencySamples.length === 0) {
			return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
		}

		const sorted = [...this.latencySamples].sort((a, b) => a - b);
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

	private getErrorStats(): ErrorStats {
		return {
			total: this.errorCount,
			byCategory: Object.fromEntries(this.errorsByCategory),
			recentErrors: [...this.recentErrors],
		};
	}

	private getThroughputStats(): ThroughputStats {
		const now = Date.now();
		const cutoff = now - this.rpsWindow;
		const recentRequests = this.requestTimestamps.filter((t) => t > cutoff).length;
		const windowSeconds = this.rpsWindow / 1000;

		return {
			totalRequests: this.totalRequests,
			successfulRequests: this.successfulRequests,
			failedRequests: this.failedRequests,
			requestsPerSecond: recentRequests / windowSeconds,
			successRate: this.totalRequests > 0 ? this.successfulRequests / this.totalRequests : 1,
		};
	}

	private percentile(sorted: number[], p: number): number {
		if (sorted.length === 0) return 0;
		const index = Math.ceil((p / 100) * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
	}
}
