/**
 * PrometheusMetricsBridge - Bridges internal metrics to OpenTelemetry/Prometheus
 *
 * Exposes TriggerMetricsCollector data as properly-named Prometheus metrics
 * using the OpenTelemetry API. Works as no-op if no MeterProvider is configured.
 */

import { type Counter, type Histogram, type Meter, type ObservableGauge, metrics } from "@opentelemetry/api";
import type { CircuitBreaker } from "./CircuitBreaker";
import type { RateLimiter } from "./RateLimiter";
import type { TriggerMetricsCollector } from "./TriggerMetricsCollector";

export interface PrometheusMetricsBridgeConfig {
	triggerType: string;
	triggerName: string;
}

export interface ExecutionLabels {
	workflow_name: string;
	workflow_version: string;
	env: string;
	/**
	 * OBS-05 T2 — resolved terminal run status for error emission
	 * (`failed` | `crashed` | `timedOut` | `throttled` | `cancelled`).
	 * Optional for back-compat: when absent, `recordError` omits the
	 * `status` label and prior behavior is preserved.
	 */
	status?: string;
}

export class PrometheusMetricsBridge {
	private meter: Meter;
	private config: PrometheusMetricsBridgeConfig;
	private collector: TriggerMetricsCollector;
	private circuitBreaker: CircuitBreaker | null = null;
	private rateLimiter: RateLimiter | null = null;

	// Active instruments
	private executionsCounter: Counter;
	private durationHistogram: Histogram;
	private errorsCounter: Counter;

	// Observable instruments (registered once, polled at scrape time)
	private observableGauges: ObservableGauge[] = [];

	private initialized = false;

	constructor(config: PrometheusMetricsBridgeConfig, collector: TriggerMetricsCollector) {
		this.config = config;
		this.collector = collector;
		this.meter = metrics.getMeter("blok");

		// Create active instruments immediately
		this.executionsCounter = this.meter.createCounter("blok_workflow_executions_total", {
			description: "Total number of workflow executions",
			unit: "1",
		});

		this.durationHistogram = this.meter.createHistogram("blok_workflow_duration_seconds", {
			description: "Workflow execution duration in seconds",
			unit: "s",
		});

		this.errorsCounter = this.meter.createCounter("blok_workflow_errors_total", {
			description: "Total number of workflow execution errors",
			unit: "1",
		});
	}

	/**
	 * Register observable callbacks that pull from the TriggerMetricsCollector
	 * at scrape time. Call this once after construction.
	 */
	initialize(): void {
		if (this.initialized) return;
		this.initialized = true;

		const baseAttrs = {
			trigger_type: this.config.triggerType,
			trigger_name: this.config.triggerName,
		};

		// Latency percentile gauges (pulled from collector at scrape time)
		const p50 = this.meter.createObservableGauge("blok_trigger_latency_p50_seconds", {
			description: "Trigger request latency 50th percentile in seconds",
			unit: "s",
		});
		p50.addCallback((result) => {
			const m = this.collector.getMetrics();
			result.observe(m.latency.p50 / 1000, baseAttrs);
		});
		this.observableGauges.push(p50);

		const p95 = this.meter.createObservableGauge("blok_trigger_latency_p95_seconds", {
			description: "Trigger request latency 95th percentile in seconds",
			unit: "s",
		});
		p95.addCallback((result) => {
			const m = this.collector.getMetrics();
			result.observe(m.latency.p95 / 1000, baseAttrs);
		});
		this.observableGauges.push(p95);

		const p99 = this.meter.createObservableGauge("blok_trigger_latency_p99_seconds", {
			description: "Trigger request latency 99th percentile in seconds",
			unit: "s",
		});
		p99.addCallback((result) => {
			const m = this.collector.getMetrics();
			result.observe(m.latency.p99 / 1000, baseAttrs);
		});
		this.observableGauges.push(p99);

		// Throughput
		const rps = this.meter.createObservableGauge("blok_trigger_throughput_rps", {
			description: "Trigger requests per second",
			unit: "1/s",
		});
		rps.addCallback((result) => {
			const m = this.collector.getMetrics();
			result.observe(m.throughput.requestsPerSecond, baseAttrs);
		});
		this.observableGauges.push(rps);

		const successRate = this.meter.createObservableGauge("blok_trigger_success_rate", {
			description: "Trigger success rate (0-1)",
			unit: "1",
		});
		successRate.addCallback((result) => {
			const m = this.collector.getMetrics();
			result.observe(m.throughput.successRate, baseAttrs);
		});
		this.observableGauges.push(successRate);

		// Active connections (for WebSocket/SSE)
		const connections = this.meter.createObservableGauge("blok_trigger_active_connections", {
			description: "Number of active connections",
			unit: "1",
		});
		connections.addCallback((result) => {
			const m = this.collector.getMetrics();
			result.observe(m.activeConnections, baseAttrs);
		});
		this.observableGauges.push(connections);

		// Process metrics
		const heapMemory = this.meter.createObservableGauge("blok_process_memory_heap_bytes", {
			description: "Process heap memory usage in bytes",
			unit: "By",
		});
		heapMemory.addCallback((result) => {
			const memUsage = process.memoryUsage();
			result.observe(memUsage.heapUsed, { trigger_type: this.config.triggerType });
		});
		this.observableGauges.push(heapMemory);

		const rssMemory = this.meter.createObservableGauge("blok_process_memory_rss_bytes", {
			description: "Process RSS memory in bytes",
			unit: "By",
		});
		rssMemory.addCallback((result) => {
			const memUsage = process.memoryUsage();
			result.observe(memUsage.rss, { trigger_type: this.config.triggerType });
		});
		this.observableGauges.push(rssMemory);

		// Circuit breaker state gauge
		const cbState = this.meter.createObservableGauge("blok_circuit_breaker_state", {
			description: "Circuit breaker state (0=closed, 1=open, 2=half_open)",
			unit: "1",
		});
		cbState.addCallback((result) => {
			if (!this.circuitBreaker) return;
			const stats = this.circuitBreaker.getStats();
			const stateValue = stats.state === "CLOSED" ? 0 : stats.state === "OPEN" ? 1 : 2;
			result.observe(stateValue, baseAttrs);
		});
		this.observableGauges.push(cbState);

		// Rate limiter remaining tokens
		const rlRemaining = this.meter.createObservableGauge("blok_rate_limiter_remaining", {
			description: "Rate limiter remaining tokens (global bucket)",
			unit: "1",
		});
		rlRemaining.addCallback((result) => {
			if (!this.rateLimiter) return;
			const peek = this.rateLimiter.peek("global");
			result.observe(peek.remaining, baseAttrs);
		});
		this.observableGauges.push(rlRemaining);
	}

	/**
	 * Record a workflow execution. Called from TriggerBase.run() after each request.
	 *
	 * @param durationMs - Execution duration in milliseconds
	 * @param success - Whether the execution succeeded
	 * @param labels - Workflow-specific labels
	 */
	recordExecution(durationMs: number, success: boolean, labels: ExecutionLabels): void {
		const attrs = {
			trigger_type: this.config.triggerType,
			trigger_name: this.config.triggerName,
			workflow_name: labels.workflow_name,
			status: success ? "success" : "error",
			env: labels.env,
		};

		this.executionsCounter.add(1, attrs);
		this.durationHistogram.record(durationMs / 1000, {
			trigger_type: this.config.triggerType,
			trigger_name: this.config.triggerName,
			workflow_name: labels.workflow_name,
			env: labels.env,
		});

		// Also record to the internal collector for percentile tracking
		if (success) {
			this.collector.recordSuccess(durationMs);
		} else {
			this.collector.recordFailure(durationMs, "execution_error", "runtime");
		}
	}

	/**
	 * Record an error with a specific category.
	 */
	recordError(category: string, labels: Partial<ExecutionLabels> = {}): void {
		const attrs: Record<string, string> = {
			trigger_type: this.config.triggerType,
			trigger_name: this.config.triggerName,
			error_category: category,
			env: labels.env || process.env.NODE_ENV || "development",
		};
		// OBS-05 T2 — distinguish failed / crashed / timedOut / throttled /
		// cancelled when the caller resolved a terminal status. Omitted for
		// back-compat when absent.
		if (labels.status) attrs.status = labels.status;
		this.errorsCounter.add(1, attrs);
	}

	/**
	 * Attach a CircuitBreaker for state monitoring.
	 */
	attachCircuitBreaker(cb: CircuitBreaker): void {
		this.circuitBreaker = cb;
	}

	/**
	 * Attach a RateLimiter for remaining token monitoring.
	 */
	attachRateLimiter(rl: RateLimiter): void {
		this.rateLimiter = rl;
	}

	/**
	 * Clean up resources.
	 */
	destroy(): void {
		this.circuitBreaker = null;
		this.rateLimiter = null;
		this.observableGauges = [];
		this.initialized = false;
	}
}
