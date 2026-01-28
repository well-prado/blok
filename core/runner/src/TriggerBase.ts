import { type Context, type LoggerContext, Metrics, Trigger } from "@nanoservice-ts/shared";
import { metrics } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";
import Configuration from "./Configuration";
import DefaultLogger from "./DefaultLogger";
import Runner from "./Runner";
import type { HMREvent } from "./hmr/FileWatcher";
import { HotReloadManager, type HotReloadManagerConfig, type HotReloadStats } from "./hmr/HotReloadManager";
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

	/** Hot reload manager - null if HMR is disabled */
	protected hmr: HotReloadManager | null = null;

	/** Number of currently in-flight requests (for zero-downtime reload) */
	protected inFlightRequests = 0;

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

	// --- Hot Module Replacement ---

	/**
	 * Enable hot reload for this trigger. Only active in development
	 * (NODE_ENV !== 'production') unless BLOK_HMR=true is explicitly set.
	 */
	async enableHotReload(config?: Partial<HotReloadManagerConfig>): Promise<void> {
		if (process.env.NODE_ENV === "production" && process.env.BLOK_HMR !== "true") {
			return;
		}

		const workflowPaths = (process.env.WORKFLOWS_PATH || process.env.VITE_WORKFLOWS_PATH || "")
			.split(",")
			.filter(Boolean);
		const nodePaths = (process.env.NODES_PATH || "").split(",").filter(Boolean);

		this.hmr = new HotReloadManager({
			workflowPaths,
			nodePaths,
			verbose: process.env.BLOK_HMR_VERBOSE === "true",
			...config,
		});

		this.hmr.onNodeChange(async (event) => {
			try {
				await this.onHmrNodeChange(event);
			} catch (err) {
				console.error(`[HMR] Error in node change handler: ${(err as Error).message}`);
			}
		});

		this.hmr.onWorkflowChange(async (event) => {
			try {
				await this.onHmrWorkflowChange(event);
			} catch (err) {
				console.error(`[HMR] Error in workflow change handler: ${(err as Error).message}`);
			}
		});

		this.hmr.onTriggerChange(async (event) => {
			try {
				await this.onHmrTriggerChange(event);
			} catch (err) {
				console.error(`[HMR] Error in trigger change handler: ${(err as Error).message}`);
			}
		});

		this.hmr.on("log", (msg: string) => console.log(msg));
		this.hmr.on("reload", (event: HMREvent) => {
			const timestamp = new Date().toLocaleTimeString();
			console.log(`[HMR] [${timestamp}] Reloaded: ${event.type} - ${event.relativePath}`);
		});
		this.hmr.on("reload-error", ({ event, error }: { event: HMREvent; error: Error }) => {
			console.error(`[HMR] Reload error for ${event.relativePath}: ${error.message}`);
		});

		await this.hmr.start();
	}

	/**
	 * Called when a node file changes. Default: invalidates module cache.
	 * Override in subclasses for custom behavior (e.g., re-running loadNodes).
	 */
	protected async onHmrNodeChange(event: HMREvent): Promise<void> {
		this.hmr?.invalidateModule(event.filePath);
	}

	/**
	 * Called when a workflow file changes. Default: no-op.
	 * HTTP trigger re-reads per request so needs no action.
	 * Non-HTTP triggers should override to reload workflow lists.
	 */
	protected async onHmrWorkflowChange(_event: HMREvent): Promise<void> {
		// Default no-op - subclasses override as needed
	}

	/**
	 * Called when a trigger config file changes. Default: no-op.
	 * Override for graceful stop + restart behavior.
	 */
	protected async onHmrTriggerChange(_event: HMREvent): Promise<void> {
		// Default no-op - subclasses override as needed
	}

	/**
	 * Wait for all in-flight requests to complete before proceeding.
	 * Used during graceful reload to avoid dropping connections.
	 */
	protected waitForInFlightRequests(timeoutMs = 5000): Promise<void> {
		return new Promise((resolve) => {
			const start = Date.now();
			const check = () => {
				if (this.inFlightRequests <= 0) {
					resolve();
				} else if (Date.now() - start >= timeoutMs) {
					console.warn(`[HMR] Timed out waiting for ${this.inFlightRequests} in-flight request(s)`);
					resolve();
				} else {
					setTimeout(check, 50);
				}
			};
			check();
		});
	}

	/**
	 * Get HMR statistics. Returns null if HMR is not enabled.
	 */
	getHmrStats(): HotReloadStats | null {
		return this.hmr?.getStats() ?? null;
	}

	/**
	 * Stop the HMR system and clean up watchers.
	 */
	async destroyHmr(): Promise<void> {
		if (this.hmr) {
			await this.hmr.stop();
			this.hmr = null;
		}
	}

	async run(ctx: Context): Promise<TriggerResponse> {
		this.inFlightRequests++;
		try {
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
		} finally {
			this.inFlightRequests--;
		}
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
