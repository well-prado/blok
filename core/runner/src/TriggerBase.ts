import { type Context, type LoggerContext, Metrics, Trigger } from "@blokjs/shared";
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
import { PrometheusMetricsBridge } from "./monitoring/PrometheusMetricsBridge";
import { RateLimiter } from "./monitoring/RateLimiter";
import type { RateLimitConfig, RateLimitResult } from "./monitoring/RateLimiter";
import { TriggerMetricsCollector } from "./monitoring/TriggerMetricsCollector";
import { RunTracker } from "./tracing/RunTracker";
import { TracingLogger } from "./tracing/TracingLogger";
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

	/** Prometheus metrics bridge for exporting to /metrics */
	protected metricsBridge: PrometheusMetricsBridge;

	/** Hot reload manager - null if HMR is disabled */
	protected hmr: HotReloadManager | null = null;

	/** Number of currently in-flight requests (for zero-downtime reload) */
	protected inFlightRequests = 0;

	constructor() {
		super();
		this.configuration = new Configuration();
		this.healthCheck = new HealthCheck();
		this.metricsCollector = new TriggerMetricsCollector(this.constructor.name, this.configuration.name || "unknown");
		this.metricsBridge = new PrometheusMetricsBridge(
			{
				triggerType: this.constructor.name,
				triggerName: this.configuration.name || "unknown",
			},
			this.metricsCollector,
		);
		this.metricsBridge.initialize();
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
		const runStart = performance.now();
		let runSuccess = true;

		// --- Trace: start run ---
		const tracker = RunTracker.getInstance();
		let traceRunId: string | undefined;
		if (tracker.active) {
			const runner = this.getRunner();
			const stepCount = runner.getStepCount?.() ?? this.configuration.steps?.length ?? 0;
			// Tier 1 · replay lineage. The replay endpoint
			// (TraceRouter.POST /__blok/runs/:id/replay) sets
			// `X-Blok-Replay-Of: <originalRunId>` on the dispatched HTTP
			// request. Read it here so the new run carries `replayOf` and
			// Studio can render a "Replay of #..." breadcrumb.
			const reqHeaders = (ctx.request?.headers ?? {}) as Record<string, string | string[] | undefined>;
			const replayOfHeader = reqHeaders["x-blok-replay-of"] ?? reqHeaders["X-Blok-Replay-Of"];
			const replayOf = Array.isArray(replayOfHeader)
				? replayOfHeader[0]
				: typeof replayOfHeader === "string"
					? replayOfHeader
					: undefined;
			const run = tracker.startRun({
				workflowName: this.configuration.name || ctx.workflow_name || "unknown",
				workflowPath: ctx.workflow_path || "",
				triggerType: this.constructor.name.replace("Trigger", "").toLowerCase() || "unknown",
				triggerSummary: this.buildTraceTriggerSummary(ctx),
				nodeCount: stepCount,
				replayOf,
			});
			traceRunId = run.id;
			(ctx as Record<string, unknown>)._traceRunId = run.id;

			// Wrap logger to forward log entries to RunTracker
			ctx.logger = new TracingLogger(ctx.logger, run.id, tracker);
		}

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

			// --- Trace: complete run ---
			if (traceRunId) {
				tracker.completeRun(traceRunId, context.response?.data);
			}

			return {
				ctx: context,
				metrics: average,
			};
		} catch (err) {
			runSuccess = false;

			// --- Trace: fail run ---
			if (traceRunId) {
				tracker.failRun(traceRunId, err instanceof Error ? err : new Error(String(err)));
			}

			throw err;
		} finally {
			const durationMs = performance.now() - runStart;
			this.metricsBridge.recordExecution(durationMs, runSuccess, {
				workflow_name: this.configuration.name || "",
				workflow_version: `${this.configuration.version}`,
				env: process.env.NODE_ENV || "development",
			});
			this.inFlightRequests--;
		}
	}

	/**
	 * Build a human-readable trigger summary for trace display.
	 */
	protected buildTraceTriggerSummary(ctx: Context): string {
		const req = ctx.request as Record<string, unknown>;
		if (req?.method && req?.path) {
			return `${(req.method as string).toUpperCase()} ${req.path}`;
		}
		return this.constructor.name.replace("Trigger", "").toLowerCase();
	}

	createContext(logger?: LoggerContext, blueprintPath?: string, id?: string): Context {
		const requestId: string = id || uuid();
		const request = { body: {} };
		const response = { data: "", contentType: "", success: true, error: null };
		// Single state object — shared by ctx.state (canonical) and ctx.vars
		// (legacy alias). All step outputs land here unless `ephemeral: true`.
		const state: Record<string, unknown> = {};

		const ctx: Context = {
			id: requestId,
			workflow_name: this.configuration.name,
			workflow_path: blueprintPath || "",
			config: this.configuration.nodes,
			request,
			response,
			error: { message: [] },
			logger: logger || new DefaultLogger(this.configuration.name, blueprintPath, requestId),
			eventLogger: null,
			state,
			// vars is a legacy alias of state — same reference, mutations
			// to either propagate. Authors writing `ctx.vars[k] = v` keep
			// working; the runner reads via state.
			vars: state,
			_PRIVATE_: null,
		};

		// V2 read-only aliases — same object reference, no copy.
		// Reads via ctx.req / ctx.prev work; writes go to the canonical
		// field (request / response).
		Object.defineProperty(ctx, "req", {
			get() {
				return ctx.request;
			},
			enumerable: true,
		});
		Object.defineProperty(ctx, "prev", {
			get() {
				return ctx.response;
			},
			enumerable: true,
		});

		// Explicit side-channel publication. Writes to state under `name`
		// and emits a Studio trace event. Most nodes don't need this —
		// returning the value lets the runner persist it via PersistenceHelper.
		ctx.publish = (name: string, value: unknown): void => {
			(ctx.state as Record<string, unknown>)[name] = value;
			const evt = ctx.eventLogger as { emit?: (event: string, payload: unknown) => void } | null;
			evt?.emit?.("publish", { name, value, runId: requestId });
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
		this.metricsBridge.destroy();
	}
}
