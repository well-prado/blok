/**
 * WorkerTrigger - Background job processing for Blok workflows
 *
 * Extends TriggerBase to support long-running background jobs:
 * - Concurrency controls (max N concurrent jobs)
 * - Retry logic with exponential backoff
 * - Job timeouts
 * - Job priority and delay scheduling
 * - Dead letter queue support
 *
 * Pattern:
 * 1. loadNodes() - Load available nodes into NodeMap
 * 2. loadWorkflows() - Load workflows with worker triggers
 * 3. listen() - Connect to job backend and start processing
 * 4. For each job:
 *    - Create context with this.createContext()
 *    - Populate ctx.request with job data
 *    - Execute workflow via this.run(ctx)
 *    - Ack on success, retry or DLQ on failure
 */

import { type WorkerTriggerOpts, type WorkflowV2Builder, tryParseDuration } from "@blokjs/helper";
import {
	type BlokService,
	ConcurrencyLimitError,
	ConcurrencyMetrics,
	Configuration,
	DebounceCoordinator,
	DefaultLogger,
	DeferredDispatchSignal,
	type GlobalOptions,
	Janitor,
	NodeMap,
	QueueExpiredError,
	RunCancelledError,
	RunTracker,
	TriggerBase,
	type TriggerResponse,
	WorkflowRegistry,
	bootstrapTracing,
	createConcurrencyBackend,
	createDebounceBackend,
} from "@blokjs/runner";
import type { Context, RequestContext } from "@blokjs/shared";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";

/**
 * F4 / F24 — thrown by `executeWithTimeout` when a worker job exceeds its
 * trigger-level `config.timeout`. A dedicated type (instead of a plain
 * `Error`) lets `handleJob`'s catch discriminate the timeout: it aborts the
 * detached run via `ctx.signal` and flips the run record to `timedOut`
 * (matching the per-step `maxDuration` taxonomy) rather than routing the
 * timeout through the generic retry/DLQ path.
 */
export class WorkerTimeoutError extends Error {
	public readonly timeoutMs: number;
	/** Run id of the aborted run, when known — used to flip status to `timedOut`. */
	public readonly runId?: string;

	constructor(timeoutMs: number, runId?: string) {
		super(`Job timed out after ${timeoutMs}ms`);
		this.name = "WorkerTimeoutError";
		this.timeoutMs = timeoutMs;
		this.runId = runId;
		Object.setPrototypeOf(this, WorkerTimeoutError.prototype);
	}
}

/**
 * Job received from worker queue
 */
export interface WorkerJob {
	/** Unique job ID */
	id: string;
	/** Job data payload */
	data: unknown;
	/** Job metadata headers */
	headers: Record<string, string>;
	/** Queue name this job belongs to */
	queue: string;
	/** Job priority (higher = more important) */
	priority: number;
	/** Number of attempts made so far */
	attempts: number;
	/** Maximum retry attempts */
	maxRetries: number;
	/** Timestamp when job was created */
	createdAt: Date;
	/** Delay before processing (ms) */
	delay?: number;
	/** Job timeout (ms) */
	timeout?: number;
	/** Original raw job from provider */
	raw: unknown;
	/** Mark job as completed */
	complete: () => Promise<void>;
	/** Mark job as failed (optionally requeue) */
	fail: (error: Error, requeue?: boolean) => Promise<void>;
}

/**
 * Worker adapter interface - implemented by each job backend
 */
export interface WorkerAdapter {
	/** Provider name (e.g., "bullmq", "in-memory") */
	readonly provider: string;

	/** Connect to the job backend */
	connect(): Promise<void>;

	/** Disconnect from the job backend */
	disconnect(): Promise<void>;

	/**
	 * Start processing jobs from a queue
	 * @param config Worker trigger configuration
	 * @param handler Callback for each job
	 */
	process(config: WorkerTriggerOpts, handler: (job: WorkerJob) => Promise<void>): Promise<void>;

	/**
	 * Add a job to a queue (for programmatic dispatching)
	 * @param queue Queue name
	 * @param data Job payload
	 * @param opts Job options
	 */
	addJob(
		queue: string,
		data: unknown,
		opts?: {
			priority?: number;
			delay?: number;
			retries?: number;
			timeout?: number;
			jobId?: string;
		},
	): Promise<string>;

	/** Stop processing a specific queue */
	stopProcessing(queue: string): Promise<void>;

	/** Check if connected */
	isConnected(): boolean;

	/** Health check */
	healthCheck(): Promise<boolean>;

	/** Get queue stats */
	getQueueStats(queue: string): Promise<WorkerQueueStats>;
}

/**
 * Queue statistics
 */
export interface WorkerQueueStats {
	/** Number of jobs waiting to be processed */
	waiting: number;
	/** Number of jobs currently being processed */
	active: number;
	/** Number of completed jobs */
	completed: number;
	/** Number of failed jobs */
	failed: number;
	/** Number of delayed jobs */
	delayed: number;
}

/**
 * Workflow model with worker trigger configuration
 */
interface WorkerWorkflowModel {
	path: string;
	config: {
		name: string;
		version: string;
		trigger?: {
			worker?: WorkerTriggerOpts;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
}

/**
 * WorkerTrigger - Abstract base class for worker-based triggers
 *
 * Provides background job processing with:
 * - Configurable concurrency per queue
 * - Automatic retries with exponential backoff
 * - Job timeouts with automatic failure
 * - Priority-based job ordering
 * - Delayed job scheduling
 * - Queue statistics and monitoring
 */
export abstract class WorkerTrigger extends TriggerBase {
	protected nodeMap: GlobalOptions = {} as GlobalOptions;
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-worker-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	protected readonly logger = new DefaultLogger();
	/** OBS-02 T4 — graceful shutdown for the OTel tracer provider, if tracing was enabled. */
	private tracingShutdown: (() => Promise<void>) | null = null;
	/**
	 * v0.7 PR 5 — the "default" adapter, used when a workflow's
	 * `trigger.worker.provider` field is omitted AND the
	 * `BLOK_WORKER_ADAPTER` env var is unset. Subclasses MAY set this
	 * for back-compat with the pre-v0.7 single-adapter pattern
	 * (`class WorkerServer extends WorkerTrigger { protected adapter = new NATSWorkerAdapter() }`).
	 *
	 * When unset AND no per-workflow provider is specified, the factory
	 * falls back to `in-memory`. The factory pool (`adapters/factory.ts`)
	 * tracks one connected adapter per provider so multiple workflows
	 * with the same provider share a single broker connection.
	 */
	protected adapter?: WorkerAdapter;

	/** Active queues being processed */
	protected activeQueues: Set<string> = new Set();

	/**
	 * v0.7 PR 5 — adapter pool, keyed by provider name. Populated lazily
	 * inside `listen()` as workflows are matched to providers. Each
	 * adapter is connected once and reused across workflows that share
	 * its provider. Drained in `stop()`.
	 */
	protected adapterPool: Map<string, WorkerAdapter> = new Map();

	// Subclasses provide these
	protected abstract nodes: Record<string, BlokService<unknown>>;
	protected abstract workflows: Record<string, WorkflowV2Builder>;

	// Constructor removed in v0.6.3 — pre-fix it called `loadNodes()` +
	// `loadWorkflows()`, but subclasses use class-field assignments for
	// `nodes` / `workflows` (the canonical TypeScript pattern). Those
	// fields run AFTER super(), so accessing `this.nodes` from the parent
	// constructor read `undefined` and crashed with
	// `TypeError: undefined is not an object (Object.keys(this.nodes))`.
	// The registry init now happens at the start of `listen()`, after
	// the subclass's fields are initialized.

	/**
	 * Load nodes into the node map
	 */
	loadNodes(): void {
		this.nodeMap.nodes = new NodeMap();
		const nodeKeys = Object.keys(this.nodes);
		for (const key of nodeKeys) {
			this.nodeMap.nodes.addNode(key, this.nodes[key]);
		}
	}

	/**
	 * Load workflows into the workflow map
	 */
	loadWorkflows(): void {
		this.nodeMap.workflows = this.workflows;
	}

	/**
	 * Start the worker processor - main entry point
	 */
	async listen(): Promise<number> {
		const startTime = this.startCounter();

		// OBS-02 T4 — opt-in distributed tracing for worker jobs. When
		// OTEL_EXPORTER_OTLP_ENDPOINT is set, install an OTel SDK so the spans
		// the runner creates per job/step export to Tempo/Jaeger/etc. Mirrors
		// HttpTrigger's B1 wiring; no-op + zero overhead when the env var is unset.
		await this.maybeBootstrapTracing();

		// Populate the trigger's node + workflow registries from the
		// subclass's `nodes` / `workflows` fields. v0.6.3 fix — pre-fix
		// these calls lived in the constructor and crashed because class
		// fields haven't run yet at super-constructor time. See the comment
		// where the old constructor used to live for the full reason.
		this.loadNodes();
		this.loadWorkflows();

		// F6 (worker part) — feed the WorkflowRegistry from the worker nodeMap.
		// Worker-only deployments never instantiate an HttpTrigger, so without
		// this the registry is empty and any trigger-level / process-global
		// middleware name or `subworkflow:` step fails at runtime. Workflows
		// flagged `middleware: true` are registered with `isMiddleware`.
		this.registerWorkflowsFromNodeMap(this.logger);

		// F14 (worker part) — seed BLOK_GLOBAL_MIDDLEWARE from env. Only
		// HttpTrigger did this before, so a pure worker process silently
		// dropped the documented env-var configuration.
		this.seedGlobalMiddlewareFromEnv(this.logger);

		try {
			// Tier 2 #6 follow-up · install the cross-process concurrency
			// backend (NATS KV) when the operator opted in via
			// `BLOK_CONCURRENCY_BACKEND=nats-kv`. Default null preserves the
			// existing in-process behavior.
			//
			// PR 3 D1 — record install attempts via OTel counter.
			try {
				const backend = createConcurrencyBackend();
				if (backend) {
					await backend.connect();
					RunTracker.getInstance().setConcurrencyBackend(backend);
					ConcurrencyMetrics.getInstance().recordBackendInstall({
						backend: backend.name,
						status: "success",
					});
					this.logger.log(`[concurrency] backend installed: ${backend.name}`);
				}
			} catch (err) {
				ConcurrencyMetrics.getInstance().recordBackendInstall({
					backend: "unknown",
					status: "failure",
				});
				this.logger.error(
					`[concurrency] backend install failed: ${err instanceof Error ? err.message : String(err)}; falling back to in-process behavior`,
				);
			}

			// Tier C #1 · install the cross-process debounce backend
			// (NATS KV / Redis) when the operator opted in via
			// `BLOK_DEBOUNCE_BACKEND`. Default unset = the existing
			// in-process behavior is preserved. On connect failure, log +
			// fall back to in-memory coordination.
			try {
				const debounceBackend = createDebounceBackend();
				if (debounceBackend) {
					const leaseRaw = process.env.BLOK_DEBOUNCE_OWNER_LEASE_MS;
					if (leaseRaw && /^\d+$/.test(leaseRaw)) {
						DebounceCoordinator.getInstance().setOwnerLeaseMs(Number(leaseRaw));
					}
					await debounceBackend.connect();
					DebounceCoordinator.getInstance().setBackend(debounceBackend);
					this.logger.log(`[debounce] backend installed: ${debounceBackend.name}`);
				}
			} catch (err) {
				this.logger.error(
					`[debounce] backend install failed: ${err instanceof Error ? err.message : String(err)}; falling back to in-memory coordination`,
				);
			}

			// Tier 2 quick-wins follow-up · install crash handlers + recover
			// orphaned runs from a previous (dead) process. Idempotent + opt-out
			// via `BLOK_CRASH_AUTOFLIP_DISABLED=1`.
			try {
				WorkerTrigger.installCrashHandlers(this.logger);
				const orphaned = WorkerTrigger.recoverOrphanedRuns(undefined, this.logger);
				if (orphaned > 0) {
					this.logger.log(`[crash-autoflip] flipped ${orphaned} orphaned run(s) to crashed on boot`);
				}
			} catch (err) {
				this.logger.error(`[crash-autoflip] setup failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			// Tier 2 follow-up · start the periodic storage janitor.
			// Idempotent (singleton); opt-out via `BLOK_JANITOR_DISABLED=1`.
			try {
				Janitor.getInstance(RunTracker.getInstance().getStore(), this.logger).start();
			} catch (err) {
				this.logger.error(`[janitor] setup failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			// Tier 2 follow-up · install graceful shutdown handlers
			// (SIGTERM / SIGINT). Idempotent; opt-out via
			// `BLOK_GRACEFUL_SHUTDOWN_DISABLED=1`.
			try {
				WorkerTrigger.installShutdownHandlers(this, this.logger);
			} catch (err) {
				this.logger.error(`[shutdown] setup failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			// Find all workflows with worker triggers
			const workerWorkflows = this.getWorkerWorkflows();

			if (workerWorkflows.length === 0) {
				this.logger.log("No workflows with worker triggers found");
				return this.endCounter(startTime);
			}

			// Start processing each queue, dispatching to the right adapter
			// based on the workflow's `provider` field (with back-compat
			// fallback to `this.adapter` when subclasses still set it).
			for (const workflow of workerWorkflows) {
				const config = workflow.config.trigger?.worker as WorkerTriggerOpts;
				const adapter = await this.resolveAdapterForWorkflow(config);
				this.logger.log(
					`Starting worker for queue: ${config.queue} via ${adapter.provider} (concurrency=${config.concurrency}, retries=${config.retries})`,
				);

				this.activeQueues.add(config.queue);

				await adapter.process(config, async (job) => {
					await this.handleJob(job, workflow, config);
				});
			}

			this.logger.log(`Worker trigger started. Processing ${workerWorkflows.length} queue(s)`);

			// Enable HMR in development mode
			if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
				await this.enableHotReload();
			}

			return this.endCounter(startTime);
		} catch (error) {
			this.logger.error(`Failed to start worker trigger: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Stop all workers and disconnect
	 */
	/**
	 * OBS-02 T4 — install the OpenTelemetry SDK at boot when an OTLP endpoint is
	 * configured, so the spans the runner already creates for worker jobs export
	 * to a backend (Tempo/Jaeger/…). No-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is
	 * unset or `BLOK_TRACING_DISABLED=1`. Stores the shutdown so `stop()` flushes.
	 */
	private async maybeBootstrapTracing(): Promise<void> {
		if (process.env.BLOK_TRACING_DISABLED === "1") return;
		const base = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		if (!base) return;
		const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ? base : `${base.replace(/\/$/, "")}/v1/traces`;
		try {
			const result = await bootstrapTracing({
				serviceName: process.env.APP_NAME || process.env.PROJECT_NAME || "blok-worker",
				serviceVersion: process.env.PROJECT_VERSION,
				exporter: "otlp",
				endpoint,
			});
			if (result) {
				this.tracingShutdown = result.shutdown;
				this.logger.log(`[blok][tracing] OTLP distributed tracing enabled → ${endpoint}`);
			} else {
				this.logger.error(
					"[blok][tracing] OTEL_EXPORTER_OTLP_ENDPOINT is set but the OTel trace SDK isn't installed — tracing is OFF.",
				);
			}
		} catch (err) {
			this.logger.error(`[blok][tracing] failed to initialize: ${(err as Error).message}`);
		}
	}

	async stop(): Promise<void> {
		// OBS-02 T4 — flush pending spans before draining so the last jobs'
		// spans aren't lost on shutdown.
		if (this.tracingShutdown) {
			await this.tracingShutdown().catch((err) =>
				this.logger.error(`[blok][tracing] shutdown failed: ${(err as Error).message}`),
			);
			this.tracingShutdown = null;
		}
		// Stop each queue on its owning adapter — adapters are tracked
		// in the pool so multi-provider workers all drain cleanly.
		for (const queue of this.activeQueues) {
			for (const adapter of this.adapterPool.values()) {
				try {
					await adapter.stopProcessing(queue);
				} catch {
					/* swallow — adapter may not own this queue */
				}
			}
			this.logger.log(`Stopped processing queue: ${queue}`);
		}
		this.activeQueues.clear();
		// Disconnect every adapter we ever connected.
		for (const adapter of this.adapterPool.values()) {
			try {
				await adapter.disconnect();
			} catch (err) {
				this.logger.error(`[blok][worker] disconnect failed: ${(err as Error).message}`);
			}
		}
		this.adapterPool.clear();
		this.destroyMonitoring();
		this.logger.log("Worker trigger stopped");
	}

	protected override async onHmrWorkflowChange(): Promise<void> {
		this.logger.log("[HMR] Worker workflow changed, reloading...");
		await this.waitForInFlightRequests();
		await this.stop();
		this.loadWorkflows();
		await this.listen();
	}

	/**
	 * Dispatch a job to a worker queue
	 */
	async dispatch(
		queue: string,
		data: unknown,
		opts?: {
			priority?: number;
			delay?: number;
			retries?: number;
			timeout?: number;
			jobId?: string;
		},
	): Promise<string> {
		// Back-compat: when a subclass set `this.adapter`, use it.
		// Otherwise dispatch via the first pool adapter — typically the
		// only one when a process owns one trigger workflow.
		const adapter =
			this.adapter ??
			(this.adapterPool.size > 0 ? (this.adapterPool.values().next().value as WorkerAdapter) : undefined);
		if (!adapter) {
			throw new Error(
				"[blok][worker] dispatch() called before any adapter is connected. Call listen() first, or set this.adapter on the subclass.",
			);
		}
		return adapter.addJob(queue, data, opts);
	}

	/**
	 * Get statistics for a queue
	 */
	async getQueueStats(queue: string): Promise<WorkerQueueStats> {
		const adapter =
			this.adapter ??
			(this.adapterPool.size > 0 ? (this.adapterPool.values().next().value as WorkerAdapter) : undefined);
		if (!adapter) {
			throw new Error(
				"[blok][worker] getQueueStats() called before any adapter is connected. Call listen() first, or set this.adapter on the subclass.",
			);
		}
		return adapter.getQueueStats(queue);
	}

	/**
	 * Get list of active queues
	 */
	getActiveQueues(): string[] {
		return Array.from(this.activeQueues);
	}

	/**
	 * v0.7 PR 5 — pick the adapter for a workflow's `provider` field.
	 *
	 * Resolution order:
	 *   1. Subclass-set `this.adapter` (back-compat: pre-v0.7 pattern
	 *      where one process binds to one adapter at construction time).
	 *   2. Per-workflow `provider` field, looked up via the factory.
	 *   3. `BLOK_WORKER_ADAPTER` env var.
	 *   4. `in-memory` fallback.
	 *
	 * Adapters are connected on first use and pooled per provider so
	 * multiple workflows sharing a provider share one broker
	 * connection. Health-dependency registration also happens here so
	 * each provider is tracked individually in `/health`.
	 */
	protected async resolveAdapterForWorkflow(config: WorkerTriggerOpts): Promise<WorkerAdapter> {
		// Subclass override wins for back-compat.
		if (this.adapter) {
			if (!this.adapter.isConnected()) {
				await this.adapter.connect();
				this.logger.log(`Connected to ${this.adapter.provider} worker system (subclass adapter)`);
				this.registerAdapterHealth(this.adapter);
			}
			// Pool-track so stop() can drain it.
			this.adapterPool.set(this.adapter.provider, this.adapter);
			return this.adapter;
		}

		// Lazy-import the factory so the worker package doesn't pull in
		// every adapter on import — only the ones actually exercised.
		const { resolveProvider, createWorkerAdapter } = await import("./adapters/factory");
		const provider = resolveProvider(config.provider);
		let adapter = this.adapterPool.get(provider);
		if (!adapter) {
			adapter = createWorkerAdapter(provider);
			await adapter.connect();
			this.logger.log(`Connected to ${adapter.provider} worker system`);
			this.registerAdapterHealth(adapter);
			this.adapterPool.set(provider, adapter);
		}
		return adapter;
	}

	private registerAdapterHealth(adapter: WorkerAdapter): void {
		this.registerHealthDependency(`worker-${adapter.provider}`, async () => {
			const healthy = await adapter.healthCheck();
			return {
				status: healthy ? ("healthy" as const) : ("unhealthy" as const),
				lastChecked: Date.now(),
				message: healthy ? "Connected" : "Connection lost",
			};
		});
	}

	/**
	 * Get all workflows that have worker triggers
	 */
	protected getWorkerWorkflows(): WorkerWorkflowModel[] {
		const workflows: WorkerWorkflowModel[] = [];

		for (const [path, workflow] of Object.entries(this.nodeMap.workflows || {})) {
			const workflowConfig = (workflow as unknown as { _config: WorkerWorkflowModel["config"] })._config;

			// F11 — discover the worker trigger by direct key access, NOT by
			// inspecting only the FIRST key. A multi-trigger workflow such as
			// `trigger: { http: {...}, worker: { queue: "jobs" } }` declares
			// `worker` second; the old `Object.keys(trigger)[0] === "worker"`
			// check silently dropped it, making discovery depend on JS object
			// key insertion order. Every sibling trigger (HTTP/SSE/Webhook)
			// already reads its key directly.
			if (workflowConfig?.trigger?.worker) {
				workflows.push({
					path,
					config: workflowConfig,
				});
			}
		}

		return workflows;
	}

	/**
	 * Handle an incoming job
	 */
	protected async handleJob(job: WorkerJob, workflow: WorkerWorkflowModel, config: WorkerTriggerOpts): Promise<void> {
		const jobId = job.id || uuid();
		const defaultMeter = metrics.getMeter("default");
		const workerJobs = defaultMeter.createCounter("worker_jobs_processed", {
			description: "Worker jobs processed",
		});
		const workerErrors = defaultMeter.createCounter("worker_jobs_failed", {
			description: "Worker job failures",
		});
		const workerRetries = defaultMeter.createCounter("worker_jobs_retried", {
			description: "Worker job retries",
		});

		await this.tracer.startActiveSpan(`worker:${config.queue}`, async (span: Span) => {
			// F2 — give each job its OWN Configuration so concurrent jobs
			// (`concurrency > 1`, or two queues in one process) never read a
			// step list / name / trigger config another job's `init()`
			// overwrote. Declared outside the try so the catch can flip the
			// run's status via the per-job config name.
			const configuration = new Configuration();
			// F4 — captured from createContext so the timeout path can abort
			// the detached run cooperatively.
			let runCtx: Context | undefined;
			try {
				const start = performance.now();

				// Bug 03 — resolve the already-loaded workflow object from the
				// in-memory nodeMap and pass it as the `preloaded` arg (mirrors
				// HTTP). This routes init through the preloaded branch and skips
				// the disk-based `LocalStorage` resolver whose dot heuristic
				// rejected dotted `domain.action` workflow names ("File type not
				// supported"). Fallback to `workflow.config` so `preloaded` is
				// never undefined (which would re-trigger the disk branch).
				const preloaded =
					(this.nodeMap.workflows && (this.nodeMap.workflows as Record<string, unknown>)[workflow.path]) ??
					workflow.config;

				// F2 — initialize the per-job Configuration instead of the shared
				// `this.configuration`.
				await configuration.init(workflow.path, this.nodeMap, preloaded);

				// Create context — bind it to the per-job Configuration (F2).
				const ctx: Context = this.createContext(undefined, workflow.path, jobId, configuration);
				runCtx = ctx;

				// Populate request with job data
				ctx.request = {
					body: job.data,
					headers: job.headers,
					query: {},
					params: {
						queue: job.queue,
						jobId: job.id,
						attempt: String(job.attempts),
						priority: String(job.priority),
					},
				} as unknown as RequestContext;

				// Store worker metadata in context
				if (!ctx.vars) ctx.vars = {};
				ctx.vars._worker_job = {
					id: job.id,
					queue: job.queue,
					attempts: String(job.attempts),
					maxRetries: String(job.maxRetries),
					priority: String(job.priority),
					createdAt: job.createdAt.toISOString(),
					delay: String(job.delay ?? 0),
					timeout: String(job.timeout ?? 0),
				};

				ctx.logger.log(
					`Processing job ${jobId} from ${config.queue} (attempt ${job.attempts + 1}/${job.maxRetries + 1})`,
				);

				// v0.6 · apply the merged middleware chain (process-global →
				// workflow-level → trigger-level) on the same ctx the main
				// workflow will see. State mutations from middleware
				// (e.g. ctx.state.identity) carry forward. Middleware that
				// throws (via `@blokjs/throw`) propagates to the outer
				// catch and is routed through the worker's retry / DLQ
				// logic exactly like a main-workflow error.
				//
				// F2 — pass the per-job `configuration` so trigger-level
				// (`trigger.worker.middleware`) and workflow-level middleware
				// are read from the object THIS job initialized. Without it the
				// chain would read the never-initialized shared `this.configuration`
				// (the worker no longer calls `this.configuration.init`) and
				// silently drop everything but the process-global chain.
				await this.applyMiddlewareChain(ctx, this.nodeMap, configuration);

				// Execute workflow with timeout if configured.
				// F2 — pass the per-job `configuration` into `run` so the runner
				// reads the same object this job initialized.
				let response: TriggerResponse;
				if (config.timeout && config.timeout > 0) {
					response = await this.executeWithTimeout(ctx, config.timeout, configuration);
				} else {
					response = await this.run(ctx, configuration);
				}

				const end = performance.now();

				// Set span attributes
				span.setAttribute("success", true);
				span.setAttribute("job_id", jobId);
				span.setAttribute("queue", config.queue);
				span.setAttribute("attempts", job.attempts);
				span.setAttribute("elapsed_ms", end - start);
				span.setStatus({ code: SpanStatusCode.OK });

				// Record metrics
				workerJobs.add(1, {
					env: process.env.NODE_ENV,
					queue: config.queue,
					workflow_name: configuration.name,
					success: "true",
				});

				ctx.logger.log(`Job completed in ${(end - start).toFixed(2)}ms: ${jobId}`);

				// Mark job as completed
				await job.complete();
			} catch (error) {
				const errorMessage = (error as Error).message;

				// Tier 2 #5 + #7 — deferred dispatch (delay/TTL/debounce).
				// The run was deferred to a future timer; ACK without retry.
				// The in-process scheduler owns the eventual dispatch, NOT
				// the broker — re-queueing here would create a duplicate.
				if (error instanceof DeferredDispatchSignal) {
					span.setAttribute("success", false);
					span.setAttribute("deferred", true);
					span.setAttribute("deferred_status", error.info.status);
					span.setStatus({ code: SpanStatusCode.OK, message: `deferred:${error.info.status}` });

					this.logger.log(
						`[scheduling] job ${jobId} runId=${error.info.runId} status=${error.info.status} ` +
							`scheduledAt=${error.info.scheduledAt} pingCount=${error.info.pingCount} → ACK (no requeue)`,
					);

					await job.complete();
					return;
				}

				// PR 1-5 polish — queue-mode TTL elapsed. The run is already
				// flipped to `expired` (see TriggerBase queue branch); ACK
				// without retry so the broker doesn't redeliver — the run
				// will never succeed (timer won't re-fire). Distinct from
				// the throttled NACK below.
				if (error instanceof QueueExpiredError) {
					span.setAttribute("success", false);
					span.setAttribute("queue_expired", true);
					span.setStatus({ code: SpanStatusCode.OK, message: "queue_expired" });

					this.logger.log(
						`[concurrency] job ${jobId} runId=${error.info.runId} key='${error.info.concurrencyKey}' ` +
							`queueExpiredAt=${error.info.queueExpiredAt} → ACK (no requeue, run expired)`,
					);

					await job.complete();
					return;
				}

				// Tier 2 #6 — concurrency gate denial. Distinct from a normal
				// failure: NACK with redelivery so the broker re-queues the
				// job with its existing back-off semantics. Doesn't count
				// against the workflow's retry budget (different invariant).
				// We always pass `willRetry: true` regardless of `job.attempts`
				// because throttling is a transient resource state, not a
				// permanent failure.
				if (error instanceof ConcurrencyLimitError) {
					span.setAttribute("success", false);
					span.setAttribute("will_retry", true);
					span.setAttribute("throttled", true);
					span.setStatus({ code: SpanStatusCode.OK, message: "concurrency_limit_reached" });

					this.logger.log(
						`[concurrency] job ${jobId} key='${error.info.concurrencyKey}' ` +
							`limit=${error.info.concurrencyLimit} inFlight=${error.info.currentInFlight} → NACK + redelivery`,
					);

					workerRetries.add(1, {
						env: process.env.NODE_ENV,
						queue: config.queue,
						workflow_name: configuration?.name || "unknown",
						reason: "throttled",
					});

					await job.fail(error as Error, true);
					return;
				}

				// F3 — the run was cancelled by an operator
				// (`POST /__blok/runs/:runId/cancel`). `RunnerSteps` throws
				// `RunCancelledError`, which `TriggerBase.run` re-throws
				// untouched (status already flipped to `cancelled`). The run is
				// terminal — ACK the broker WITHOUT requeue so the
				// deliberately-cancelled, often non-idempotent work doesn't run
				// again on redelivery.
				if (error instanceof RunCancelledError) {
					span.setAttribute("success", false);
					span.setAttribute("cancelled", true);
					span.setStatus({ code: SpanStatusCode.OK, message: "run_cancelled" });

					this.logger.log(`Job ${jobId} cancelled (run already terminal) → ACK (no requeue)`);

					await job.complete();
					return;
				}

				// F4 / F24 — trigger-level `config.timeout` elapsed. The detached
				// run was already aborted via `ctx.signal` inside
				// `executeWithTimeout`, so it unwinds with `RunCancelledError`
				// at the next between-step check. Flip the run record to the
				// dedicated `timedOut` status (matching the per-step
				// `maxDuration` taxonomy) instead of routing through the generic
				// retry/DLQ path, and ACK without requeue.
				if (error instanceof WorkerTimeoutError) {
					span.setAttribute("success", false);
					span.setAttribute("timed_out", true);
					span.setStatus({ code: SpanStatusCode.ERROR, message: "job_timed_out" });

					const timedOutRunId = error.runId ?? (runCtx as { _traceRunId?: string } | undefined)?._traceRunId;
					if (timedOutRunId) {
						try {
							RunTracker.getInstance().markRunTimedOut(timedOutRunId, {
								stepId: "__worker_timeout__",
								maxDurationMs: error.timeoutMs,
								attemptsExhausted: job.attempts + 1,
							});
						} catch (markErr) {
							this.logger.error(
								`[blok][worker] markRunTimedOut failed for run ${timedOutRunId}: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
							);
						}
					}

					workerErrors.add(1, {
						env: process.env.NODE_ENV,
						queue: config.queue,
						workflow_name: configuration?.name || "unknown",
						reason: "timeout",
					});

					this.logger.error(
						`Job ${jobId} timed out after ${error.timeoutMs}ms → run flipped to timedOut, ACK (no requeue)`,
					);

					await job.complete();
					return;
				}

				const shouldRetry = job.attempts < job.maxRetries;

				// Set span error
				span.setAttribute("success", false);
				span.setAttribute("will_retry", shouldRetry);
				span.recordException(error as Error);
				span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });

				if (shouldRetry) {
					// Retry with exponential backoff. `config.delay` widened to
					// `string | number | undefined` in Tier 2 #5 (duration strings).
					// `calculateBackoff` only handles numbers; normalize via
					// tryParseDuration. Fail-open to undefined → default backoff.
					const delayMs =
						typeof config.delay === "number"
							? config.delay
							: typeof config.delay === "string"
								? (tryParseDuration(config.delay) ?? undefined)
								: undefined;
					const backoffMs = this.calculateBackoff(job.attempts, delayMs);
					workerRetries.add(1, {
						env: process.env.NODE_ENV,
						queue: config.queue,
						workflow_name: configuration?.name || "unknown",
						attempt: String(job.attempts + 1),
					});

					this.logger.error(
						`Job ${jobId} failed (attempt ${job.attempts + 1}/${job.maxRetries + 1}), retrying in ${backoffMs}ms: ${errorMessage}`,
					);

					await job.fail(error as Error, true);
				} else {
					// Max retries exhausted - send to DLQ
					workerErrors.add(1, {
						env: process.env.NODE_ENV,
						queue: config.queue,
						workflow_name: configuration?.name || "unknown",
					});

					this.logger.error(
						`Job ${jobId} permanently failed after ${job.attempts + 1} attempts: ${errorMessage}`,
						(error as Error).stack,
					);

					await job.fail(error as Error, false);
				}
			} finally {
				span.end();
			}
		});
	}

	/**
	 * Execute workflow with a timeout.
	 *
	 * F4 — on timeout, fire the ctx AbortController so the detached `run`
	 * unwinds cooperatively (it throws `RunCancelledError` at the next
	 * between-step check; long uninterruptible nodes should still poll
	 * `ctx.signal.aborted`). The promise rejects with a dedicated
	 * {@link WorkerTimeoutError} carrying the run id so `handleJob`'s catch can
	 * flip the run record to `timedOut` (F24). The second `run` (broker
	 * redelivery) is prevented because we ACK without requeue on timeout.
	 *
	 * F2 — `configuration` is the per-job Configuration; threaded into `run`.
	 */
	protected async executeWithTimeout(
		ctx: Context,
		timeoutMs: number,
		configuration?: Configuration,
	): Promise<TriggerResponse> {
		return new Promise<TriggerResponse>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;

				// F4 — abort the detached run so it stops executing rather than
				// continuing to settle its own run record out of band.
				const privateSlot = ctx._PRIVATE_ as { abortController?: AbortController } | null;
				try {
					privateSlot?.abortController?.abort();
				} catch {
					/* best-effort — abort never throws, but guard anyway */
				}

				const runId = (ctx as { _traceRunId?: string })._traceRunId;
				reject(new WorkerTimeoutError(timeoutMs, runId));
			}, timeoutMs);

			this.run(ctx, configuration)
				.then((result) => {
					clearTimeout(timer);
					if (settled) return; // already timed out — ignore the late result
					settled = true;
					resolve(result);
				})
				.catch((error) => {
					clearTimeout(timer);
					if (settled) return; // already rejected with WorkerTimeoutError
					settled = true;
					reject(error);
				});
		});
	}

	/**
	 * Calculate exponential backoff delay
	 * Formula: min(baseDelay * 2^attempt, 30000) + jitter
	 */
	protected calculateBackoff(attempt: number, baseDelay?: number): number {
		const base = baseDelay ?? 1000;
		const maxDelay = 30000; // 30 seconds max
		const exponential = Math.min(base * 2 ** attempt, maxDelay);
		const jitter = Math.random() * exponential * 0.1; // 10% jitter
		return Math.floor(exponential + jitter);
	}
}

export default WorkerTrigger;
