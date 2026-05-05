import { type Context, type LoggerContext, Metrics, Trigger } from "@blokjs/shared";
import { metrics } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";
import Configuration from "./Configuration";
import DefaultLogger from "./DefaultLogger";
import { RunCancelledError } from "./RunCancelledError";
import Runner from "./Runner";
import { WaitDispatchRequest } from "./WaitDispatchRequest";
import { ConcurrencyLimitError } from "./concurrency/ConcurrencyLimitError";
import { QueueExpiredError } from "./concurrency/QueueExpiredError";
import { readConcurrencyConfig } from "./concurrency/readConcurrencyConfig";
import type { HMREvent } from "./hmr/FileWatcher";
import { HotReloadManager, type HotReloadManagerConfig, type HotReloadStats } from "./hmr/HotReloadManager";
import { resolveIdempotencyKey } from "./idempotency/resolveIdempotencyKey";
import { CircuitBreaker } from "./monitoring/CircuitBreaker";
import type { CircuitBreakerConfig } from "./monitoring/CircuitBreaker";
import { ConcurrencyMetrics } from "./monitoring/ConcurrencyMetrics";
import { HealthCheck } from "./monitoring/HealthCheck";
import type { DependencyCheckFn } from "./monitoring/HealthCheck";
import { PrometheusMetricsBridge } from "./monitoring/PrometheusMetricsBridge";
import { RateLimiter } from "./monitoring/RateLimiter";
import type { RateLimitConfig, RateLimitResult } from "./monitoring/RateLimiter";
import { TriggerMetricsCollector } from "./monitoring/TriggerMetricsCollector";
import { DebounceCoordinator } from "./scheduling/DebounceCoordinator";
import { DeferredDispatchSignal } from "./scheduling/DeferredDispatchSignal";
import { DeferredRunScheduler } from "./scheduling/DeferredRunScheduler";
import { type NormalizedSchedulingConfig, readSchedulingConfig } from "./scheduling/readSchedulingConfig";
import { RunTracker } from "./tracing/RunTracker";
import { TracingLogger } from "./tracing/TracingLogger";
import type TriggerResponse from "./types/TriggerResponse";

/**
 * Tier 2 quick-wins follow-up · structural logger interface used by
 * `installCrashHandlers` and `recoverOrphanedRuns`. Both `error` and
 * `log` are optional so callers can pass a `DefaultLogger`, the Hono
 * `console` shim, a custom logger, or omit it entirely.
 *
 * Single-arg calls (one pre-formatted string) are intentional — Node's
 * `process.on("uncaughtException")` handlers can't await, and the
 * `DefaultLogger` interface only takes `(message: string)`.
 */
interface CrashAutoflipLogger {
	error?: (message: string) => void;
	log?: (message: string) => void;
}

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

	/**
	 * Tier 2 #5+#7 follow-up — durable scheduler hook.
	 *
	 * When a trigger supports re-firing deferred dispatches across process
	 * restarts, it overrides this method to extract a JSON-serializable
	 * subset of `ctx` sufficient for `restoreDispatch(payload)` (defined
	 * by the trigger) to reconstruct an equivalent ctx and re-enter
	 * `dispatchDeferred`.
	 *
	 * Returns `null` (default) when the trigger does NOT support
	 * cross-restart durability — the scheduler then runs purely in-memory
	 * for that trigger (existing pre-follow-up behaviour).
	 *
	 * Override in `HttpTrigger` to return `{method, path, headers, body,
	 * params, query, workflowPath}` (with sensitive header keys stripped).
	 * Worker triggers don't override — broker handles delay durability.
	 */
	protected extractDispatchPayload(_ctx: Context): unknown | null {
		return null;
	}

	/**
	 * Returns the trigger type string used to tag persisted scheduled
	 * dispatch rows (`scheduled_dispatches.trigger_type`). Mirrors the
	 * convention from `tracker.startRun({triggerType})`. Override when
	 * the class name doesn't naturally produce the right tag.
	 */
	protected getTriggerType(): string {
		return this.constructor.name.replace("Trigger", "").toLowerCase() || "unknown";
	}

	// --- Crash auto-flip (Tier 2 quick-wins follow-up) ---

	/** Flag — set true after `installCrashHandlers` has run once in this process. */
	private static crashHandlersInstalled = false;

	/**
	 * Tier 2 quick-wins follow-up — install process-level handlers for
	 * `uncaughtException` and `unhandledRejection`. When fired, flip
	 * every in-flight `running` run to `"crashed"` (with the captured
	 * error) BEFORE re-throwing / letting Node's default behavior take
	 * over. Idempotent — safe to call from every trigger's `listen()`;
	 * only the first call installs handlers.
	 *
	 * Kill-switch: `BLOK_CRASH_AUTOFLIP_DISABLED=1`.
	 *
	 * Why sync: `process.on("uncaughtException")` handlers can't await.
	 * `markAllRunningRunsAsCrashed` is sync (sqlite + in-memory writes
	 * complete before the handler returns).
	 */
	static installCrashHandlers(logger?: CrashAutoflipLogger): void {
		if (TriggerBase.crashHandlersInstalled) return;
		if (process.env.BLOK_CRASH_AUTOFLIP_DISABLED === "1") return;
		TriggerBase.crashHandlersInstalled = true;

		const onUncaught = (err: Error) => {
			try {
				const flipped = RunTracker.getInstance().markAllRunningRunsAsCrashed(err);
				logger?.error?.(
					`[blok][crash-autoflip] uncaughtException — flipped ${flipped} running run(s) to crashed: ${err.stack || err.message}`,
				);
			} catch (markErr) {
				// Last-ditch — at least log so the operator knows the autoflip itself failed.
				console.error("[blok][crash-autoflip] markAllRunningRunsAsCrashed failed:", markErr);
			}
			// Re-emit / let the runtime crash as expected — we don't want to
			// silently swallow uncaught errors. Without this, Node would
			// continue running with the handler attached but operators
			// expect the process to die on uncaught exceptions.
			throw err;
		};

		const onRejection = (reason: unknown) => {
			const err = reason instanceof Error ? reason : new Error(String(reason));
			try {
				const flipped = RunTracker.getInstance().markAllRunningRunsAsCrashed(err);
				logger?.error?.(
					`[blok][crash-autoflip] unhandledRejection — flipped ${flipped} running run(s) to crashed: ${err.stack || err.message}`,
				);
			} catch (markErr) {
				console.error("[blok][crash-autoflip] markAllRunningRunsAsCrashed failed:", markErr);
			}
			// Don't re-throw — unhandledRejection is a warning, not a crash.
			// Node's default behavior (warn + continue) still applies because
			// our handler is additive, not replacing the default.
		};

		process.on("uncaughtException", onUncaught);
		process.on("unhandledRejection", onRejection);
	}

	/** Test-only — reset the install flag so tests can re-install handlers. */
	static resetCrashHandlersInstalled(): void {
		TriggerBase.crashHandlersInstalled = false;
	}

	// --- Graceful shutdown (Tier 2 follow-up) ---

	/** Flag — set true after `installShutdownHandlers` has run once in this process. */
	private static shutdownHandlersInstalled = false;

	/**
	 * Install SIGTERM + SIGINT handlers that drain process resources
	 * cleanly before exit. Mirrors the `installCrashHandlers` pattern —
	 * idempotent + opt-out via `BLOK_GRACEFUL_SHUTDOWN_DISABLED=1`.
	 *
	 * Drain order:
	 * 1. Stop accepting new work — calls `trigger.stop()` if available
	 *    (HttpTrigger drains in-flight requests + closes the server).
	 * 2. Stop the periodic janitor sweep so it doesn't fire mid-drain.
	 * 3. Cancel pending deferred dispatches in the in-memory scheduler.
	 *    (Persisted rows in `scheduled_dispatches` survive — the next
	 *    boot recovers them.)
	 * 4. Disconnect the cross-process concurrency backend (NATS KV)
	 *    so locks held by this process release on the broker side.
	 * 5. `process.exit(0)`.
	 *
	 * Errors during drain are caught + logged; the process still exits
	 * (cleanup is best-effort; the operator wants a clean exit).
	 *
	 * Why this is a `static` method: shutdown handlers must be installed
	 * once per process, regardless of how many trigger subclasses
	 * coexist. Subclasses pass `this` so the handler can call their
	 * specific `stop()`.
	 */
	static installShutdownHandlers(trigger: TriggerBase, logger?: CrashAutoflipLogger): void {
		if (TriggerBase.shutdownHandlersInstalled) return;
		if (process.env.BLOK_GRACEFUL_SHUTDOWN_DISABLED === "1") return;
		TriggerBase.shutdownHandlersInstalled = true;

		const onSignal = async (signal: NodeJS.Signals) => {
			logger?.log?.(`[blok][shutdown] received ${signal} — draining...`);
			try {
				// 1. Stop the trigger (drain in-flight, close server).
				const stoppable = trigger as TriggerBase & { stop?: () => Promise<void> };
				if (typeof stoppable.stop === "function") {
					await stoppable.stop();
				}

				// 2. Stop the janitor.
				try {
					const { Janitor } = await import("./tracing/Janitor");
					const janitor = (Janitor as unknown as { instance?: { stop(): void } }).instance;
					if (janitor) janitor.stop();
				} catch {
					// Janitor may not have been imported yet.
				}

				// 3. Clear pending deferred dispatches (in-memory only —
				// persisted rows survive for next-boot recovery).
				try {
					DeferredRunScheduler.getInstance().clear();
				} catch {
					// Best-effort.
				}

				// 4. Disconnect cross-process concurrency backend.
				//
				// PR 3 D5 — wrap disconnect() in a Promise.race timeout so a
				// slow NATS drain doesn't hang past the SIGTERM-to-SIGKILL
				// window. Default 10s; configurable via
				// BLOK_BACKEND_DISCONNECT_TIMEOUT_MS. Timer is .unref()'d so
				// it doesn't keep the event loop alive after a successful
				// disconnect.
				const backend = RunTracker.getInstance().getConcurrencyBackend();
				if (backend) {
					const disconnectTimeoutMs = (() => {
						const raw = process.env.BLOK_BACKEND_DISCONNECT_TIMEOUT_MS;
						if (!raw || !/^\d+$/.test(raw)) return 10_000;
						return Number(raw);
					})();
					try {
						await Promise.race([
							backend.disconnect(),
							new Promise<never>((_, reject) => {
								const t = setTimeout(
									() => reject(new Error(`backend.disconnect() timed out after ${disconnectTimeoutMs}ms`)),
									disconnectTimeoutMs,
								);
								t.unref?.();
							}),
						]);
					} catch (err) {
						logger?.error?.(
							`[blok][shutdown] backend disconnect failed (or timed out): ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}

				logger?.log?.("[blok][shutdown] graceful shutdown complete");
			} catch (err) {
				logger?.error?.(`[blok][shutdown] drain error: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				process.exit(0);
			}
		};

		process.on("SIGTERM", onSignal);
		process.on("SIGINT", onSignal);
	}

	/** Test-only — reset the install flag so tests can re-install handlers. */
	static resetShutdownHandlersInstalled(): void {
		TriggerBase.shutdownHandlersInstalled = false;
	}

	/**
	 * Tier 2 quick-wins follow-up — boot recovery for orphaned `running`
	 * runs. Scans the store for runs in `running` status whose
	 * `startedAt` is older than `thresholdMs` ago (default 2 minutes,
	 * override via `BLOK_ORPHAN_THRESHOLD_MS` env var). Flips each to
	 * `"crashed"` with `Error("Orphaned — process restarted before run completed")`.
	 *
	 * Catches the case where the previous process died via SIGKILL or
	 * OOM and the `installCrashHandlers` path never ran. Returns the
	 * count flipped for observability + tests.
	 *
	 * Idempotent — safe to call multiple times; runs are flipped to
	 * a terminal status so a second pass finds none.
	 */
	static recoverOrphanedRuns(thresholdMs?: number, logger?: CrashAutoflipLogger): number {
		if (process.env.BLOK_CRASH_AUTOFLIP_DISABLED === "1") return 0;

		const envThreshold = process.env.BLOK_ORPHAN_THRESHOLD_MS;
		const threshold =
			thresholdMs ?? (envThreshold && /^\d+$/.test(envThreshold) ? Number(envThreshold) : 2 * 60 * 1000);

		const tracker = RunTracker.getInstance();
		if (!tracker.active) return 0;

		const cutoff = Date.now() - threshold;
		const flipped = tracker.markAllRunningRunsAsCrashed(
			new Error("Orphaned — process restarted before run completed"),
			{ maxStartedAt: cutoff },
		);

		if (flipped > 0) {
			logger?.log?.(
				`[blok][crash-autoflip] boot recovery — flipped ${flipped} orphaned run(s) older than ${threshold}ms to crashed`,
			);
		}
		return flipped;
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
		// Tier 2 #6 — concurrency lock claim, populated when the gate grants
		// a slot. Released in the `finally` block. Null when the workflow has
		// no concurrency gate or the gate failed open (key resolution).
		let acquiredLock: { workflowName: string; concurrencyKey: string; runId: string } | null = null;

		// --- Trace: start run ---
		// Tier 2 #5 + #7 · skip startRun on re-entry from a deferred timer.
		// The deferred dispatcher (DeferredRunScheduler / DebounceCoordinator)
		// re-enters `run(ctx)` with `_blokDispatchReentry = true` after the
		// wait window closes; the existing run record is reused via
		// `ctx._traceRunId`.
		const tracker = RunTracker.getInstance();
		let traceRunId: string | undefined;
		const ctxRecord = ctx as Record<string, unknown>;
		const isReentryAtTrace = ctxRecord._blokDispatchReentry === true;

		if (tracker.active && isReentryAtTrace) {
			traceRunId = ctxRecord._traceRunId as string | undefined;
			// Logger wrapping was already applied on the first pass — no
			// need to re-wrap (and re-wrapping would double-route logs).

			// PR 1 follow-up · A2 fix. The first-pass `finally` block
			// unregisters the AbortController via `tracker.unregisterAbortController`.
			// Without re-registering on re-entry, `tracker.abortRunningRun(runId)`
			// can't fire the controller — the controller stays on
			// `ctx._PRIVATE_.abortController` but the tracker's lookup
			// returns undefined. Operator cancel of a `running` run that
			// came from delayed/queued/debounced flips status to "cancelled"
			// but the in-flight step never sees `ctx.signal.aborted`.
			// Re-register here mirroring the first-pass branch below.
			if (traceRunId) {
				const privateSlot = ctx._PRIVATE_ as { abortController?: AbortController } | null;
				if (privateSlot?.abortController) {
					tracker.registerAbortController(traceRunId, privateSlot.abortController);
				}
			}
		} else if (tracker.active) {
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
			ctxRecord._traceRunId = run.id;

			// Tier 2 follow-up · register the ctx's AbortController so the
			// cancel API can fire it for `running` runs. Stashed on
			// _PRIVATE_ by createContext; lookup via the optional shape.
			const privateSlot = ctx._PRIVATE_ as { abortController?: AbortController } | null;
			if (privateSlot?.abortController) {
				tracker.registerAbortController(run.id, privateSlot.abortController);
			}

			// Wrap logger to forward log entries to RunTracker
			ctx.logger = new TracingLogger(ctx.logger, run.id, tracker);
		}

		try {
			// --- Scheduling gates (Tier 2 #5 + #7) ---
			// Run BEFORE the concurrency gate. Order: debounce → delay.
			// Each gate may throw `DeferredDispatchSignal` to short-circuit
			// the immediate dispatch path; the transport layer (HTTP/Worker)
			// catches it and translates to 202 Accepted / NACK.
			//
			// Skipped on re-entry from a deferred timer (the timer callback
			// sets `_blokDispatchReentry = true` on ctx) so we don't loop.
			// Also skipped when:
			//  - tracker inactive (deferred dispatch needs persistence to
			//    survive even within the process lifetime)
			//  - `BLOK_SCHEDULING_DISABLED=1` (kill-switch).
			const isReentry = (ctx as Record<string, unknown>)._blokDispatchReentry === true;
			if (!isReentry && traceRunId && process.env.BLOK_SCHEDULING_DISABLED !== "1") {
				const schedCfg = readSchedulingConfig(this.configuration.trigger as Record<string, unknown> | undefined);
				if (schedCfg) {
					const signal = this.maybeDeferRun(ctx, traceRunId, schedCfg);
					if (signal) throw signal;
				}
			}

			// --- Concurrency gate (Tier 2 #6) ---
			// Runs after `tracker.startRun` so denied attempts appear in
			// Studio with status "throttled". Skipped when:
			//  - tracker is inactive (lock store IS the run store)
			//  - the trigger config has no `concurrencyKey`
			//  - the resolved key is null/undefined (fail-open, matches
			//    idempotency-cache semantics)
			//  - `BLOK_CONCURRENCY_DISABLED=1` (kill-switch).
			if (traceRunId && process.env.BLOK_CONCURRENCY_DISABLED !== "1") {
				const concCfg = readConcurrencyConfig(this.configuration.trigger as Record<string, unknown> | undefined);
				if (concCfg) {
					const resolvedKey = resolveIdempotencyKey(concCfg.keyExpression, ctx);
					if (resolvedKey !== null) {
						const workflowName = this.configuration.name || ctx.workflow_name || "unknown";
						const now = Date.now();
						const result = await tracker.acquireConcurrencySlot(
							workflowName,
							resolvedKey,
							concCfg.limit,
							traceRunId,
							now + concCfg.leaseMs,
						);
						if (!result.acquired) {
							// Tier 2 #6 follow-up — when the trigger is configured with
							// `onLimit: "queue"`, defer the run via the in-process scheduler
							// (Tier 2 #5+#7 plumbing) and re-attempt acquisition after a 1s
							// delay instead of throwing. HTTP gets 202 + Location, Worker
							// ACKs without retry. Re-defer happens transparently when the
							// timer fires and the gate denies again.
							if (concCfg.onLimit === "queue") {
								// PR 5 B2 — TTL on queued runs. Compute on
								// the first queue attempt and persist on the
								// run record so re-defer attempts can check
								// it. The existing `expiresAt` field on
								// WorkflowRun is reused.
								const existingRun = tracker.getStore().getRun(traceRunId);
								const queueExpiresAt =
									existingRun?.expiresAt !== undefined
										? existingRun.expiresAt
										: concCfg.queueTimeoutMs !== undefined
											? now + concCfg.queueTimeoutMs
											: undefined;

								if (queueExpiresAt !== undefined && now > queueExpiresAt) {
									// TTL elapsed — flip to expired, no further re-defer.
									tracker.markRunExpired(traceRunId, {
										expiresAt: queueExpiresAt,
										expiredAt: now,
									});
									ConcurrencyMetrics.getInstance().recordDenied({
										workflow_name: workflowName,
										concurrency_key: resolvedKey,
										mode: "queue",
									});
									// PR 1-5 polish · throw a dedicated error so the HTTP
									// transport returns 410 Gone instead of 429 Retry-After.
									// Conflating queue-expired (permanently dead — the timer
									// won't re-fire) with throttled (transient resource
									// pressure) misleads clients into retrying. Status was
									// already flipped to `expired` above, so the run record
									// reflects reality regardless of the transport choice.
									throw new QueueExpiredError({
										workflowName,
										concurrencyKey: resolvedKey,
										queueExpiredAt: queueExpiresAt,
										runId: traceRunId,
									});
								}

								// PR 5 B3 — capped exponential backoff for re-defer.
								// Track attempt count via existing pingCount field on the run record.
								const attempt = existingRun?.pingCount ?? 0;
								const minBackoff = concCfg.queueRetry?.minBackoffMs ?? 1000;
								const maxBackoff = concCfg.queueRetry?.maxBackoffMs ?? 30_000;
								const factor = concCfg.queueRetry?.factor ?? 2;
								const retryAfterMs = Math.min(maxBackoff, minBackoff * factor ** attempt);
								const scheduledAt = now + retryAfterMs;

								tracker.markRunQueued(traceRunId, {
									concurrencyKey: resolvedKey,
									concurrencyLimit: concCfg.limit,
									currentInFlight: result.currentInFlight,
									scheduledAt,
								});

								// Bump pingCount (= attempt counter for backoff) and
								// persist queueExpiresAt on first queue attempt.
								tracker.getStore().updateRun(traceRunId, {
									pingCount: attempt + 1,
									...(queueExpiresAt !== undefined && existingRun?.expiresAt === undefined
										? { expiresAt: queueExpiresAt }
										: {}),
								});

								ConcurrencyMetrics.getInstance().recordDenied({
									workflow_name: workflowName,
									concurrency_key: resolvedKey,
									mode: "queue",
								});

								const expiresAtForDispatch: number | undefined = undefined;
								// Tier 2 #5+#7 follow-up · durable scheduling. Persist the
								// dispatch row only when the subclass provides a payload
								// (HttpTrigger.extractDispatchPayload returns the request
								// subset; default returns null = in-memory only).
								const persistPayload = this.extractDispatchPayload(ctx);
								DeferredRunScheduler.getInstance().schedule(
									traceRunId,
									scheduledAt,
									async () => {
										await this.dispatchDeferred(ctx, traceRunId as string, expiresAtForDispatch);
									},
									persistPayload === null
										? undefined
										: {
												workflowName,
												triggerType: this.getTriggerType(),
												expiresAt: expiresAtForDispatch,
												dispatchStatus: "queued",
												payload: persistPayload,
											},
								);

								throw new DeferredDispatchSignal({
									runId: traceRunId,
									workflowName,
									status: "queued",
									scheduledAt,
									debounced: false,
									pingCount: 1,
								});
							}

							tracker.markRunThrottled(traceRunId, {
								concurrencyKey: resolvedKey,
								concurrencyLimit: concCfg.limit,
								currentInFlight: result.currentInFlight,
							});
							ConcurrencyMetrics.getInstance().recordDenied({
								workflow_name: workflowName,
								concurrency_key: resolvedKey,
								mode: "throw",
							});
							throw new ConcurrencyLimitError({
								workflowName,
								concurrencyKey: resolvedKey,
								concurrencyLimit: concCfg.limit,
								currentInFlight: result.currentInFlight,
								retryAfterMs: 1000,
								runId: traceRunId,
							});
						}
						acquiredLock = { workflowName, concurrencyKey: resolvedKey, runId: traceRunId };
						ConcurrencyMetrics.getInstance().recordAcquired({
							workflow_name: workflowName,
							concurrency_key: resolvedKey,
						});
					}
				}
			}

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

			// PR 4 — wait.for / wait.until step requesting deferred dispatch.
			// Translate to the existing scheduling pipeline:
			//   1. Mark run "delayed" with the wait deadline as scheduledAt.
			//   2. Persist the dispatch row (durable scheduler) so the wait
			//      survives process restart.
			//   3. Register a setTimeout via DeferredRunScheduler.
			//   4. Throw DeferredDispatchSignal — HTTP transport returns 202.
			// The runner already set lastCompletedStepIndex before throwing
			// WaitDispatchRequest so the dispatchDeferred re-entry skips
			// past completed pre-wait steps.
			if (err instanceof WaitDispatchRequest && traceRunId) {
				const workflowName = this.configuration.name || ctx.workflow_name || "unknown";
				const scheduledAt = err.info.scheduledAt;
				const delayMs = Math.max(0, scheduledAt - Date.now());

				tracker.markRunDelayed(traceRunId, { scheduledAt, delayMs });

				const persistPayload = this.extractDispatchPayload(ctx);
				DeferredRunScheduler.getInstance().schedule(
					traceRunId,
					scheduledAt,
					async () => {
						await this.dispatchDeferred(ctx, traceRunId as string, undefined);
					},
					persistPayload === null
						? undefined
						: {
								workflowName,
								triggerType: this.getTriggerType(),
								dispatchStatus: "delayed",
								payload: persistPayload,
							},
				);

				// Throw DeferredDispatchSignal so the transport layer can
				// translate to 202 Accepted (HTTP) / ACK without retry (Worker).
				throw new DeferredDispatchSignal({
					runId: traceRunId,
					workflowName,
					status: "delayed",
					scheduledAt,
					debounced: false,
					pingCount: 1,
				});
			}

			// --- Trace: fail run ---
			// Tier 2 #6: ConcurrencyLimitError already flipped the run's
			// status to "throttled" via markRunThrottled — don't override
			// it with "failed". The transport layer translates → 429 / NACK.
			//
			// Tier 2 #5 + #7: DeferredDispatchSignal already flipped the
			// run's status to "delayed" or "debounced". Don't override it
			// with "failed". The transport layer translates → 202 Accepted.
			//
			// Tier 2 follow-up: RunCancelledError is thrown by RunnerSteps
			// when an operator cancels via `abortRunningRun`. The tracker
			// has already flipped the run to "cancelled"; don't override.
			//
			// PR 4: WaitDispatchRequest is handled above (translated to
			// DeferredDispatchSignal); shouldn't reach here.
			//
			// PR 1-5 polish: QueueExpiredError flipped the run's status to
			// "expired" via markRunExpired — don't override it with
			// "failed". The HTTP transport translates → 410 Gone.
			if (
				traceRunId &&
				!(err instanceof ConcurrencyLimitError) &&
				!(err instanceof QueueExpiredError) &&
				!(err instanceof DeferredDispatchSignal) &&
				!(err instanceof RunCancelledError) &&
				!(err instanceof WaitDispatchRequest)
			) {
				tracker.failRun(traceRunId, err instanceof Error ? err : new Error(String(err)));
			}

			throw err;
		} finally {
			// Release the concurrency slot if the gate granted one. Idempotent
			// at the store layer — a double-release (gate granted but then
			// crash + lazy-purge) is a no-op. `releaseConcurrencySlot` is async
			// (Tier 2 #6 follow-up cross-process backend); fire-and-forget here
			// — the finally block can't `await` cleanly across all callers, and
			// release errors don't change the run outcome. Errors logged via
			// the backend's own catch handlers.
			if (acquiredLock) {
				const lock = acquiredLock;
				void tracker.releaseConcurrencySlot(lock.workflowName, lock.concurrencyKey, lock.runId).catch((err) => {
					console.error(
						`[blok][concurrency] releaseConcurrencySlot failed for ${lock.workflowName}:${lock.concurrencyKey}:${lock.runId}:`,
						err instanceof Error ? err.stack || err.message : err,
					);
				});
				ConcurrencyMetrics.getInstance().recordReleased({
					workflow_name: lock.workflowName,
					concurrency_key: lock.concurrencyKey,
				});
			}

			// Tier 2 follow-up · clean up the AbortController registration
			// once the run is terminal. Idempotent — safe even if the run
			// was cancelled mid-flight (the tracker already aborted).
			if (traceRunId) {
				tracker.unregisterAbortController(traceRunId);
			}

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
	 * Tier 2 #5 + #7 — evaluate the scheduling gates and either return a
	 * `DeferredDispatchSignal` (the caller throws it) or null (the caller
	 * proceeds with immediate dispatch).
	 *
	 * Order: debounce → delay. They DON'T compose in a single PR (a
	 * trigger may use one or the other; both at once would be unusual).
	 * If both are configured, debounce takes precedence — the debounce
	 * coordinator handles its own scheduling (the `delay` field is
	 * effectively ignored on debounced triggers).
	 */
	private maybeDeferRun(
		ctx: Context,
		traceRunId: string,
		schedCfg: NormalizedSchedulingConfig,
	): DeferredDispatchSignal | null {
		const tracker = RunTracker.getInstance();
		const workflowName = this.configuration.name || ctx.workflow_name || "unknown";

		// === Debounce gate (Tier 2 #7) ===
		if (schedCfg.debounce) {
			const resolvedKey = resolveIdempotencyKey(schedCfg.debounce.keyExpression, ctx);
			if (resolvedKey === null) {
				// Fail-open — same semantics as concurrency-key resolution.
				return null;
			}

			// Tier 2 follow-up · persist debounce dispatches alongside delay/queue
			// entries. The DebounceCoordinator timer remains the in-process source
			// of truth (silence-window semantics + latest-payload coalesce); the
			// persisted row is for crash-recovery only. On boot, recovered
			// debounced rows fire via setTimeout (no silence-window re-establishment
			// — the time has already passed).
			const persistPayload = this.extractDispatchPayload(ctx);
			const triggerType = this.getTriggerType();

			const onFire = async (): Promise<void> => {
				try {
					await this.dispatchDeferred(ctx, traceRunId, undefined);
				} catch (err) {
					console.error(
						`[blok][scheduling] debounce dispatchDeferred failed for run ${traceRunId}:`,
						err instanceof Error ? err.stack || err.message : err,
					);
				} finally {
					// Best-effort cleanup — the DeferredRunScheduler delete-on-fire
					// path doesn't apply here (debounce uses its own timer). Use
					// the scheduler's persistedOnly cancel to delete the row.
					if (persistPayload !== null) {
						DeferredRunScheduler.getInstance().cancel(traceRunId, true);
					}
				}
			};

			const result = DebounceCoordinator.getInstance().register({
				workflowName,
				debounceKey: resolvedKey,
				mode: schedCfg.debounce.mode,
				delayMs: schedCfg.debounce.delayMs,
				maxDelayMs: schedCfg.debounce.maxDelayMs,
				runId: traceRunId,
				onFire,
			});

			if (result.outcome === "fire-immediate") {
				// Leading-mode fresh window: caller runs the workflow synchronously.
				// The coordinator already opened its window so subsequent pings
				// within `delayMs` will coalesce. Caller continues to the
				// concurrency gate + runner.run path.
				return null;
			}

			if (result.outcome === "schedule-trailing") {
				// Trailing-mode fresh window: this run is the active one. Mark
				// `debounced` (transient) and throw the signal.
				tracker.markRunDebounced(traceRunId, {
					debounceKey: resolvedKey,
					mode: schedCfg.debounce.mode,
					pingCount: result.pingCount,
					scheduledAt: result.scheduledAt,
				});
				// Tier 2 follow-up · durable debounce. Write a `dispatch_status:
				// "debounced"` row so a process crash mid-window leaves a recoverable
				// pointer at the active run + its captured payload.
				if (persistPayload !== null && tracker.active) {
					try {
						tracker.getStore().upsertScheduledDispatch({
							runId: traceRunId,
							workflowName,
							triggerType,
							scheduledAt: result.scheduledAt ?? Date.now(),
							dispatchStatus: "debounced",
							payload: persistPayload,
							createdAt: Date.now(),
						});
					} catch (err) {
						console.error(
							`[blok][scheduling] persist debounce dispatch failed for run ${traceRunId}:`,
							err instanceof Error ? err.stack || err.message : err,
						);
					}
				}
				return new DeferredDispatchSignal({
					runId: traceRunId,
					workflowName,
					status: "debounced",
					scheduledAt: result.scheduledAt ?? Date.now(),
					debounced: true,
					pingCount: result.pingCount,
				});
			}

			// Coalesce — this ping joined an existing window. Mark THIS run
			// `debounced` terminal pointing at the active run, and bump the
			// active run's pingCount (best-effort — the active run is in the
			// store).
			tracker.markRunDebounced(traceRunId, {
				debounceKey: resolvedKey,
				mode: schedCfg.debounce.mode,
				intoRunId: result.activeRunId,
				pingCount: result.pingCount,
			});
			tracker.recordDebouncePing(result.activeRunId, {
				pingCount: result.pingCount,
				scheduledAt: result.scheduledAt ?? Date.now(),
			});
			// Tier 2 follow-up · update the active run's persisted dispatch with
			// the latest payload + new scheduledAt. Trailing mode: each ping
			// resets the dispatch time, and the coordinator captures the latest
			// onFire closure — we mirror that into the persisted row so a crash
			// recovery uses the latest payload.
			if (
				result.outcome === "coalesce" &&
				schedCfg.debounce.mode === "trailing" &&
				persistPayload !== null &&
				tracker.active
			) {
				try {
					tracker.getStore().upsertScheduledDispatch({
						runId: result.activeRunId,
						workflowName,
						triggerType,
						scheduledAt: result.scheduledAt ?? Date.now(),
						dispatchStatus: "debounced",
						payload: persistPayload,
						createdAt: Date.now(),
					});
				} catch (err) {
					console.error(
						`[blok][scheduling] persist debounce coalesce failed for run ${result.activeRunId}:`,
						err instanceof Error ? err.stack || err.message : err,
					);
				}
			}
			return new DeferredDispatchSignal({
				runId: traceRunId,
				workflowName,
				status: "debounced",
				scheduledAt: result.scheduledAt ?? Date.now(),
				debounced: true,
				pingCount: result.pingCount,
				intoRunId: result.activeRunId,
			});
		}

		// === Delay gate (Tier 2 #5) ===
		if (schedCfg.delayMs !== undefined && schedCfg.delayMs > 0) {
			const scheduledAt = Date.now() + schedCfg.delayMs;
			const expiresAt = schedCfg.ttlMs !== undefined ? Date.now() + schedCfg.ttlMs : undefined;

			tracker.markRunDelayed(traceRunId, {
				scheduledAt,
				delayMs: schedCfg.delayMs,
				expiresAt,
			});

			// Tier 2 #5+#7 follow-up · durable scheduling.
			const persistPayload = this.extractDispatchPayload(ctx);
			DeferredRunScheduler.getInstance().schedule(
				traceRunId,
				scheduledAt,
				async () => {
					await this.dispatchDeferred(ctx, traceRunId, expiresAt);
				},
				persistPayload === null
					? undefined
					: {
							workflowName,
							triggerType: this.getTriggerType(),
							expiresAt,
							dispatchStatus: "delayed",
							payload: persistPayload,
						},
			);

			return new DeferredDispatchSignal({
				runId: traceRunId,
				workflowName,
				status: "delayed",
				scheduledAt,
				expiresAt,
				debounced: false,
				pingCount: 1,
			});
		}

		return null;
	}

	/**
	 * Tier 2 #5 + #7 — re-enter the dispatch pipeline for a deferred run.
	 *
	 * Called by the `DeferredRunScheduler` timer (delay) or
	 * `DebounceCoordinator.onFire` (debounce trailing) when the wait
	 * window closes. Checks TTL, transitions the run to `running`, and
	 * re-enters `run(ctx)` with the `_blokDispatchReentry` flag so the
	 * scheduling gates are skipped on the second pass.
	 *
	 * The re-entered `run(ctx)` reuses the existing `traceRunId` (already
	 * stashed on `ctx._traceRunId` from the first pass).
	 */
	protected async dispatchDeferred(ctx: Context, traceRunId: string, expiresAt: number | undefined): Promise<void> {
		const tracker = RunTracker.getInstance();

		// TTL check — fire-once-then-give-up. If the dispatch is past its
		// TTL, mark the run `expired` and abort.
		if (expiresAt !== undefined && Date.now() > expiresAt) {
			tracker.markRunExpired(traceRunId, {
				expiresAt,
				expiredAt: Date.now(),
			});
			return;
		}

		// Flip status delayed/debounced → running.
		tracker.transitionRunToRunning(traceRunId);

		// Re-enter the dispatch pipeline. The reentry flag short-circuits
		// the scheduling gates so we don't loop. The existing traceRunId
		// is preserved (no second startRun call — see top of run()).
		const ctxRecord = ctx as Record<string, unknown>;
		ctxRecord._blokDispatchReentry = true;
		try {
			await this.run(ctx);
		} catch (err) {
			// The re-entered `run()` already handled tracker.failRun /
			// markRunThrottled internally. Swallow here so timer callbacks
			// don't crash on uncaught rejections.
			void err;
		} finally {
			ctxRecord._blokDispatchReentry = false;
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

		// Tier 2 follow-up · cooperative cancellation. Each context owns
		// an AbortController whose signal flips when an operator cancels
		// the run via `POST /__blok/runs/:runId/cancel` while it's in
		// `running` status. RunnerSteps' between-step check throws
		// `RunCancelledError` which TriggerBase catches without flipping
		// the run to `failed` (the tracker has already flipped it to
		// `cancelled`).
		const abortController = new AbortController();

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
			signal: abortController.signal,
			// Stash the controller on _PRIVATE_ so TriggerBase.run can
			// hand it to the tracker without exposing it on the public ctx.
			_PRIVATE_: { abortController },
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
