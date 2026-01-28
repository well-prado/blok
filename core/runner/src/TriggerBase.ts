import { type Context, type LoggerContext, Metrics, Trigger } from "@nanoservice-ts/shared";
import { metrics } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";
import Configuration from "./Configuration";
import DefaultLogger from "./DefaultLogger";
import Runner from "./Runner";
import { CircuitBreaker } from "./monitoring/CircuitBreaker";
import type { CircuitBreakerConfig } from "./monitoring/CircuitBreaker";
import { HealthCheck } from "./monitoring/HealthCheck";
import type { DependencyCheckFn } from "./monitoring/HealthCheck";
import { RateLimiter } from "./monitoring/RateLimiter";
import type { RateLimitConfig, RateLimitResult } from "./monitoring/RateLimiter";
import { TriggerMetricsCollector } from "./monitoring/TriggerMetricsCollector";
import type TriggerResponse from "./types/TriggerResponse";

export default abstract class TriggerBase extends Trigger {
	public configuration: Configuration;

	/** Health check instance for this trigger */
	protected healthCheck: HealthCheck;

	/** Rate limiter instance - null if rate limiting is disabled */
	protected rateLimiter: RateLimiter | null = null;

	/** Circuit breaker instance - null if circuit breaker is disabled */
	protected circuitBreaker: CircuitBreaker | null = null;

	/** Enhanced metrics collector */
	protected metricsCollector: TriggerMetricsCollector;

	constructor() {
		super();
		this.configuration = new Configuration();
		this.healthCheck = new HealthCheck();
		this.metricsCollector = new TriggerMetricsCollector(
			this.constructor.name,
			this.configuration.name || "unknown",
		);
	}

	abstract listen(): Promise<number>;

	getConfiguration(): Configuration {
		return new Configuration();
	}

	getRunner(): Runner {
		return new Runner(this.configuration.steps);
	}

	async run(ctx: Context): Promise<TriggerResponse> {
		const start = performance.now();
		const defaultMeter = metrics.getMeter("default");
		const workflow_execution = defaultMeter.createCounter("workflow", {
			description: "Workflow requests",
		});

		const workflow_runner_time = defaultMeter.createGauge("workflow_time", {
			description: "Workflow elapsed time",
		});

		const workflow_memory = defaultMeter.createGauge("workflow_memory", {
			description: "Workflow memory usage",
		});

		const workflow_memory_average = defaultMeter.createGauge("workflow_memory_average", {
			description: "Workflow memory average",
		});

		const workflow_memory_usage_min = defaultMeter.createGauge("workflow_memory_usage_min", {
			description: "Workflow memory usage min",
		});

		const workflow_memory_total = defaultMeter.createGauge("workflow_memory_total", {
			description: "Workflow memory total",
		});

		const workflow_memory_free = defaultMeter.createGauge("workflow_memory_free", {
			description: "Workflow memory free",
		});

		const workflow_cpu = defaultMeter.createGauge("workflow_cpu", {
			description: "Workflow cpu usage",
		});

		const workflow_cpu_average = defaultMeter.createGauge("workflow_cpu_average", {
			description: "Workflow cpu average",
		});

		const workflow_cpu_total = defaultMeter.createGauge("workflow_cpu_total", {
			description: "Workflow cpu total",
		});

		const globalMetrics = new Metrics();
		globalMetrics.start();

		const runner: Runner = this.getRunner();
		const context = await runner.run(ctx);
		globalMetrics.retry();
		globalMetrics.stop();
		const average = await globalMetrics.getMetrics();
		const end = performance.now();

		ctx.logger.log(
			`Memory average: ${average.memory.total.toFixed(2)}MB, min: ${average.memory.min.toFixed(2)}MB, max: ${average.memory.max.toFixed(2)}MB`,
		);

		workflow_execution.add(1, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		workflow_runner_time.record(end - start, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		workflow_memory.record(average.memory.max, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		workflow_memory_average.record(average.memory.total, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		workflow_memory_usage_min.record(average.memory.min, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		workflow_memory_total.record(average.memory.global_memory, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		workflow_memory_free.record(average.memory.global_free_memory, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		workflow_cpu.record(average.cpu.usage, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		workflow_cpu_average.record(average.cpu.average, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		workflow_cpu_total.record(average.cpu.total, {
			env: process.env.NODE_ENV,
			workflow_version: `${this.configuration.version}`,
			workflow_name: `${this.configuration.name}`,
			workflow_path: `${ctx.workflow_path}`,
		});

		globalMetrics.clear();

		return {
			ctx: context,
			metrics: average,
		};
	}

	createContext(logger?: LoggerContext, blueprintPath?: string, id?: string): Context {
		const requestId: string = id || uuid();
		const ctx: Context = {
			id: requestId,
			workflow_name: this.configuration.name,
			workflow_path: blueprintPath || "",
			config: this.configuration.nodes,
			request: { body: {} },
			response: { data: "", contentType: "", success: true, error: null },
			error: { message: [] },
			logger: logger || new DefaultLogger(this.configuration.name, blueprintPath, requestId),
			eventLogger: null,
			_PRIVATE_: null,
		};

		Object.defineProperty(ctx, "id", {
			value: requestId,
			enumerable: true,
		});

		Object.defineProperty(ctx, "env", {
			value: process.env,
			enumerable: true,
		});

		return ctx;
	}

	startCounter() {
		return performance.now();
	}

	endCounter(start: number) {
		return performance.now() - start;
	}

	// --- Monitoring Infrastructure ---

	/**
	 * Enable rate limiting for this trigger.
	 */
	enableRateLimiting(config: RateLimitConfig): void {
		this.rateLimiter = new RateLimiter(config);
	}

	/**
	 * Check rate limit for a given key. Returns the result without blocking.
	 */
	checkRateLimit(key: string): RateLimitResult {
		if (!this.rateLimiter) {
			return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0, limit: 0 };
		}
		return this.rateLimiter.consume(key);
	}

	/**
	 * Enable circuit breaker for this trigger.
	 */
	enableCircuitBreaker(config: CircuitBreakerConfig): void {
		this.circuitBreaker = new CircuitBreaker(config);
	}

	/**
	 * Register a dependency health check (e.g., database, queue broker).
	 */
	registerHealthDependency(name: string, checkFn: DependencyCheckFn): void {
		this.healthCheck.registerDependency(name, checkFn);
	}

	/**
	 * Get full health status including all dependencies.
	 */
	async getHealth() {
		return this.healthCheck.check();
	}

	/**
	 * Get liveness probe result.
	 */
	getLiveness() {
		return this.healthCheck.liveness();
	}

	/**
	 * Get readiness probe result.
	 */
	async getReadiness() {
		return this.healthCheck.readiness();
	}

	/**
	 * Get enhanced trigger metrics snapshot.
	 */
	getTriggerMetrics() {
		return this.metricsCollector.getMetrics();
	}

	/**
	 * Clean up monitoring resources on shutdown.
	 */
	destroyMonitoring(): void {
		this.rateLimiter?.destroy();
		this.circuitBreaker?.destroy();
	}
}
