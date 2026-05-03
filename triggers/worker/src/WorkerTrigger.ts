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

import { type HelperResponse, type WorkerTriggerOpts, tryParseDuration } from "@blokjs/helper";
import {
	type BlokService,
	ConcurrencyLimitError,
	DefaultLogger,
	DeferredDispatchSignal,
	type GlobalOptions,
	NodeMap,
	TriggerBase,
	type TriggerResponse,
} from "@blokjs/runner";
import type { Context, RequestContext } from "@blokjs/shared";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";

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
	protected abstract adapter: WorkerAdapter;

	/** Active queues being processed */
	protected activeQueues: Set<string> = new Set();

	// Subclasses provide these
	protected abstract nodes: Record<string, BlokService<unknown>>;
	protected abstract workflows: Record<string, HelperResponse>;

	constructor() {
		super();
		this.loadNodes();
		this.loadWorkflows();
	}

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

		try {
			// Connect to job backend
			await this.adapter.connect();
			this.logger.log(`Connected to ${this.adapter.provider} worker system`);

			// Register health dependency
			this.registerHealthDependency(`worker-${this.adapter.provider}`, async () => {
				const healthy = await this.adapter.healthCheck();
				return {
					status: healthy ? ("healthy" as const) : ("unhealthy" as const),
					lastChecked: Date.now(),
					message: healthy ? "Connected" : "Connection lost",
				};
			});

			// Find all workflows with worker triggers
			const workerWorkflows = this.getWorkerWorkflows();

			if (workerWorkflows.length === 0) {
				this.logger.log("No workflows with worker triggers found");
				return this.endCounter(startTime);
			}

			// Start processing each queue
			for (const workflow of workerWorkflows) {
				const config = workflow.config.trigger?.worker as WorkerTriggerOpts;
				this.logger.log(
					`Starting worker for queue: ${config.queue} (concurrency=${config.concurrency}, retries=${config.retries})`,
				);

				this.activeQueues.add(config.queue);

				await this.adapter.process(config, async (job) => {
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
	async stop(): Promise<void> {
		for (const queue of this.activeQueues) {
			await this.adapter.stopProcessing(queue);
			this.logger.log(`Stopped processing queue: ${queue}`);
		}
		this.activeQueues.clear();
		await this.adapter.disconnect();
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
		return this.adapter.addJob(queue, data, opts);
	}

	/**
	 * Get statistics for a queue
	 */
	async getQueueStats(queue: string): Promise<WorkerQueueStats> {
		return this.adapter.getQueueStats(queue);
	}

	/**
	 * Get list of active queues
	 */
	getActiveQueues(): string[] {
		return Array.from(this.activeQueues);
	}

	/**
	 * Get all workflows that have worker triggers
	 */
	protected getWorkerWorkflows(): WorkerWorkflowModel[] {
		const workflows: WorkerWorkflowModel[] = [];

		for (const [path, workflow] of Object.entries(this.nodeMap.workflows || {})) {
			const workflowConfig = (workflow as unknown as { _config: WorkerWorkflowModel["config"] })._config;

			if (workflowConfig?.trigger) {
				const triggerType = Object.keys(workflowConfig.trigger)[0];

				if (triggerType === "worker" && workflowConfig.trigger.worker) {
					workflows.push({
						path,
						config: workflowConfig,
					});
				}
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
			try {
				const start = performance.now();

				// Initialize configuration for this workflow
				await this.configuration.init(workflow.path, this.nodeMap);

				// Create context
				const ctx: Context = this.createContext(undefined, workflow.path, jobId);

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

				// Execute workflow with timeout if configured
				let response: TriggerResponse;
				if (config.timeout && config.timeout > 0) {
					response = await this.executeWithTimeout(ctx, config.timeout);
				} else {
					response = await this.run(ctx);
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
					workflow_name: this.configuration.name,
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
						workflow_name: this.configuration?.name || "unknown",
						reason: "throttled",
					});

					await job.fail(error as Error, true);
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
						workflow_name: this.configuration?.name || "unknown",
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
						workflow_name: this.configuration?.name || "unknown",
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
	 * Execute workflow with a timeout
	 */
	protected async executeWithTimeout(ctx: Context, timeoutMs: number): Promise<TriggerResponse> {
		return new Promise<TriggerResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Job timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.run(ctx)
				.then((result) => {
					clearTimeout(timer);
					resolve(result);
				})
				.catch((error) => {
					clearTimeout(timer);
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
