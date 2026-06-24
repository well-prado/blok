/**
 * CronTrigger - Scheduled workflow execution based on cron expressions
 *
 * Extends TriggerBase to support scheduled triggers:
 * - Cron expressions (e.g., "0 * * * *" for hourly)
 * - Timezone-aware scheduling
 * - Overlap prevention
 * - Manual trigger support
 *
 * Uses the 'cron' package for cron parsing and scheduling.
 */

import type { CronTriggerOpts, HelperResponse } from "@blokjs/helper";
import {
	type BlokService,
	DefaultLogger,
	DeferredDispatchSignal,
	type GlobalOptions,
	NodeMap,
	TriggerBase,
	type TriggerResponse,
	WaitDispatchRequest,
	bootstrapTracing,
} from "@blokjs/runner";
import type { Context, MetricsType, RequestContext } from "@blokjs/shared";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { CronJob } from "cron";
import { v4 as uuid } from "uuid";

/**
 * Scheduled job information
 */
export interface ScheduledJob {
	/** Unique job ID */
	id: string;
	/** Workflow path */
	workflowPath: string;
	/** Cron expression */
	schedule: string;
	/** Timezone */
	timezone: string;
	/** Allow overlapping executions */
	overlap: boolean;
	/** Whether the job is currently running */
	running: boolean;
	/** Last execution time */
	lastRun?: Date;
	/** Next scheduled time */
	nextRun?: Date;
	/** Internal CronJob instance */
	job: CronJob;
}

/**
 * Execution context passed to the workflow
 */
export interface CronExecutionContext {
	/** Job ID */
	jobId: string;
	/** Scheduled time (when it was supposed to run) */
	scheduledTime: Date;
	/** Actual execution time */
	executionTime: Date;
	/** Cron expression */
	schedule: string;
	/** Timezone */
	timezone: string;
	/** Whether this is a manual trigger */
	manual: boolean;
}

/**
 * Workflow model with cron trigger configuration
 */
interface CronWorkflowModel {
	path: string;
	config: {
		name: string;
		version: string;
		trigger?: {
			cron?: CronTriggerOpts;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
}

/**
 * CronTrigger - Scheduled workflow execution
 */
export abstract class CronTrigger extends TriggerBase {
	protected nodeMap: GlobalOptions = {} as GlobalOptions;
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-cron-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	protected readonly logger = new DefaultLogger();
	protected jobs: Map<string, ScheduledJob> = new Map();
	/** OBS-02 T4 — graceful shutdown for the OTel tracer provider, if tracing was enabled. */
	private tracingShutdown: (() => Promise<void>) | null = null;

	// Subclasses provide these
	protected abstract nodes: Record<string, BlokService<unknown>>;
	protected abstract workflows: Record<string, HelperResponse>;

	// Constructor removed (mirrors WorkerTrigger's v0.6.3 fix) — pre-fix it
	// called `loadNodes()` + `loadWorkflows()`, but subclasses use class-field
	// assignments for `nodes` / `workflows` (the canonical TypeScript pattern).
	// Those fields run AFTER super(), so accessing `this.nodes` from the parent
	// constructor read `undefined` and crashed with
	// `TypeError: Cannot convert undefined or null to object` (Object.keys(this.nodes)).
	// The registry init now happens at the start of `listen()`, after the
	// subclass's fields are initialized.

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
	 * Convert cron DateTime to Date
	 * The cron package uses luxon DateTime which has toJSDate()
	 */
	protected toDate(dateTime: unknown): Date {
		if (dateTime && typeof dateTime === "object" && "toJSDate" in dateTime) {
			return (dateTime as { toJSDate: () => Date }).toJSDate();
		}
		return dateTime instanceof Date ? dateTime : new Date(dateTime as string | number);
	}

	/**
	 * Start the cron scheduler - main entry point
	 */
	async listen(): Promise<number> {
		const startTime = this.startCounter();

		try {
			// OBS-02 T4 — opt-in distributed tracing for scheduled executions.
			// When OTEL_EXPORTER_OTLP_ENDPOINT is set, install an OTel SDK so the
			// spans the runner creates per cron run/step export to a backend.
			// Mirrors HttpTrigger's B1 wiring; no-op when the env var is unset.
			await this.maybeBootstrapTracing();

			// Populate the trigger's node + workflow registries from the
			// subclass's `nodes` / `workflows` fields. Mirrors WorkerTrigger's
			// v0.6.3 fix — pre-fix these calls lived in the constructor and
			// crashed because class fields haven't run yet at super-constructor
			// time. Must run before `registerWorkflowsFromNodeMap`,
			// which reads `this.nodeMap.workflows`.
			this.loadNodes();
			this.loadWorkflows();

			// F5 · install crash/orphan/janitor/shutdown handlers so a
			// cron-only process gets the same run-state integrity + storage
			// hygiene guarantees as HTTP/Worker. Each handler is idempotent
			// + individually kill-switched.
			this.installOperationalHandlers(this.logger);

			// F6 · feed the WorkflowRegistry from the nodeMap so `subworkflow:`
			// steps + trigger/workflow/process-global middleware resolve in a
			// cron-only deployment (no HTTP trigger to populate the registry).
			this.registerWorkflowsFromNodeMap(this.logger);

			// F14 · seed the process-global middleware chain from
			// `BLOK_GLOBAL_MIDDLEWARE` (idempotent — programmatic
			// setGlobalMiddleware takes precedence).
			this.seedGlobalMiddlewareFromEnv(this.logger);

			// Find all workflows with cron triggers
			const cronWorkflows = this.getCronWorkflows();

			if (cronWorkflows.length === 0) {
				this.logger.log("No workflows with cron triggers found");
				return this.endCounter(startTime);
			}

			// Create and start cron jobs for each workflow
			for (const workflow of cronWorkflows) {
				const config = workflow.config.trigger?.cron as CronTriggerOpts;
				const jobId = `cron-${workflow.path}-${uuid().slice(0, 8)}`;

				// `CronTriggerOpts` is `z.input<…>` so `timezone` is `string | undefined`
				// even though the schema declares `.default("UTC")`. Apply the
				// default once here so the rest of this method (and the cron lib's
				// constructor) sees a guaranteed string.
				const timezone = config.timezone ?? "UTC";

				this.logger.log(`Scheduling workflow: ${workflow.path} with schedule: ${config.schedule} (${timezone})`);

				const job = new CronJob(
					config.schedule,
					async () => {
						await this.executeWorkflow(jobId, workflow, config, false);
					},
					null, // onComplete
					false, // start
					timezone,
				);

				const scheduledJob: ScheduledJob = {
					id: jobId,
					workflowPath: workflow.path,
					schedule: config.schedule,
					timezone,
					overlap: config.overlap ?? false,
					running: false,
					nextRun: this.toDate(job.nextDate()),
					job,
				};

				this.jobs.set(jobId, scheduledJob);

				// Start the job
				job.start();
				this.logger.log(`Job ${jobId} started. Next run: ${scheduledJob.nextRun}`);
			}

			this.logger.log(`Cron trigger started. ${this.jobs.size} job(s) scheduled`);

			// Enable HMR in development mode
			if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
				await this.enableHotReload();
			}

			return this.endCounter(startTime);
		} catch (error) {
			this.logger.error(`Failed to start cron trigger: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Stop all cron jobs
	 */
	/**
	 * OBS-02 T4 — install the OpenTelemetry SDK at boot when an OTLP endpoint is
	 * configured, so the spans the runner already creates for scheduled runs
	 * export to a backend (Tempo/Jaeger/…). No-op when `OTEL_EXPORTER_OTLP_ENDPOINT`
	 * is unset or `BLOK_TRACING_DISABLED=1`. Stores the shutdown so `stop()` flushes.
	 */
	private async maybeBootstrapTracing(): Promise<void> {
		if (process.env.BLOK_TRACING_DISABLED === "1") return;
		const base = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		if (!base) return;
		const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ? base : `${base.replace(/\/$/, "")}/v1/traces`;
		try {
			const result = await bootstrapTracing({
				serviceName: process.env.APP_NAME || process.env.PROJECT_NAME || "blok-cron",
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
		// OBS-02 T4 — flush pending spans before the process exits.
		if (this.tracingShutdown) {
			await this.tracingShutdown().catch((err) =>
				this.logger.error(`[blok][tracing] shutdown failed: ${(err as Error).message}`),
			);
			this.tracingShutdown = null;
		}
		for (const [jobId, scheduledJob] of this.jobs) {
			scheduledJob.job.stop();
			this.logger.log(`Job ${jobId} stopped`);
		}
		this.jobs.clear();
		this.logger.log("Cron trigger stopped");
	}

	protected override async onHmrWorkflowChange(): Promise<void> {
		this.logger.log("[HMR] Cron workflow changed, reloading...");
		await this.waitForInFlightRequests();
		await this.stop();
		this.loadWorkflows();
		await this.listen();
	}

	/**
	 * Manually trigger a specific job
	 */
	async triggerJob(jobId: string): Promise<TriggerResponse | null> {
		const scheduledJob = this.jobs.get(jobId);
		if (!scheduledJob) {
			this.logger.error(`Job not found: ${jobId}`);
			return null;
		}

		// Get the workflow
		const workflow = this.getWorkflowByPath(scheduledJob.workflowPath);
		if (!workflow) {
			this.logger.error(`Workflow not found: ${scheduledJob.workflowPath}`);
			return null;
		}

		const config = workflow.config.trigger?.cron as CronTriggerOpts;
		return this.executeWorkflow(jobId, workflow, config, true);
	}

	/**
	 * Get all scheduled jobs
	 */
	getJobs(): ScheduledJob[] {
		return Array.from(this.jobs.values()).map((job) => ({
			...job,
			nextRun: this.toDate(job.job.nextDate()),
		}));
	}

	/**
	 * Get all workflows that have cron triggers
	 */
	protected getCronWorkflows(): CronWorkflowModel[] {
		const workflows: CronWorkflowModel[] = [];

		for (const [path, workflow] of Object.entries(this.nodeMap.workflows || {})) {
			const workflowConfig = (workflow as unknown as { _config: CronWorkflowModel["config"] })._config;

			if (workflowConfig?.trigger) {
				const triggerType = Object.keys(workflowConfig.trigger)[0];

				if (triggerType === "cron" && workflowConfig.trigger.cron) {
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
	 * Get workflow by path
	 */
	protected getWorkflowByPath(path: string): CronWorkflowModel | null {
		const workflow = this.nodeMap.workflows?.[path];
		if (!workflow) return null;

		const workflowConfig = (workflow as unknown as { _config: CronWorkflowModel["config"] })._config;
		return {
			path,
			config: workflowConfig,
		};
	}

	/**
	 * Execute a workflow
	 */
	protected async executeWorkflow(
		jobId: string,
		workflow: CronWorkflowModel,
		config: CronTriggerOpts,
		manual: boolean,
	): Promise<TriggerResponse> {
		const scheduledJob = this.jobs.get(jobId);
		if (!scheduledJob) {
			throw new Error(`Job not found: ${jobId}`);
		}

		// Check for overlap
		if (scheduledJob.running && !scheduledJob.overlap) {
			this.logger.log(`Skipping ${jobId}: previous execution still running (overlap disabled)`);
			return { ctx: {} as Context, metrics: {} as MetricsType };
		}

		const executionId = uuid();
		const lastDate = scheduledJob.job.lastDate();
		const scheduledTime = lastDate ? new Date(lastDate as unknown as string | number) : new Date();
		const executionTime = new Date();

		// Apply the schema default — see explanation in `listen()`.
		const timezone = config.timezone ?? "UTC";

		const defaultMeter = metrics.getMeter("default");
		const cronExecutions = defaultMeter.createCounter("cron_executions", {
			description: "Cron job executions",
		});
		const cronErrors = defaultMeter.createCounter("cron_errors", {
			description: "Cron job execution errors",
		});

		return new Promise((resolve) => {
			this.tracer.startActiveSpan(`cron:${workflow.path}`, async (span: Span) => {
				scheduledJob.running = true;

				try {
					const start = performance.now();

					// Initialize configuration for this workflow
					await this.configuration.init(workflow.path, this.nodeMap);

					// Create context
					const ctx: Context = this.createContext(undefined, workflow.path, executionId);

					// Create execution context
					const cronContext: CronExecutionContext = {
						jobId,
						scheduledTime,
						executionTime,
						schedule: config.schedule,
						timezone,
						manual,
					};

					// Populate request with cron context
					ctx.request = {
						body: cronContext,
						headers: {
							"x-cron-job-id": jobId,
							"x-cron-schedule": config.schedule,
							"x-cron-timezone": config.timezone,
							"x-cron-manual": String(manual),
						},
						query: {},
						params: {
							jobId,
							schedule: config.schedule,
						},
					} as unknown as RequestContext;

					// Store cron context in vars
					if (!ctx.vars) ctx.vars = {};
					ctx.vars._cron_context = {
						jobId,
						scheduledTime: scheduledTime.toISOString(),
						executionTime: executionTime.toISOString(),
						schedule: config.schedule,
						timezone: config.timezone,
						manual: String(manual),
					};

					ctx.logger.log(`Executing cron job: ${jobId} (${manual ? "manual" : "scheduled"})`);

					// v0.6 · apply the merged middleware chain (process-global →
					// workflow-level → trigger-level) before the main workflow
					// body. Lets cron workflows compose auth-check + audit-log
					// chains exactly like HTTP triggers. A throwing middleware
					// propagates to the outer catch and surfaces as a cron job
					// failure.
					await this.applyMiddlewareChain(ctx, this.nodeMap);

					// Execute workflow
					const response: TriggerResponse = await this.run(ctx);
					const end = performance.now();

					// Update job state
					scheduledJob.lastRun = executionTime;
					scheduledJob.nextRun = this.toDate(scheduledJob.job.nextDate());

					// Set span attributes
					span.setAttribute("success", true);
					span.setAttribute("job_id", jobId);
					span.setAttribute("workflow_path", workflow.path);
					span.setAttribute("schedule", config.schedule);
					span.setAttribute("timezone", timezone);
					span.setAttribute("manual", manual);
					span.setAttribute("elapsed_ms", end - start);
					span.setStatus({ code: SpanStatusCode.OK });

					// Record metrics
					cronExecutions.add(1, {
						env: process.env.NODE_ENV,
						job_id: jobId,
						workflow_name: this.configuration.name,
						manual: String(manual),
						success: "true",
					});

					ctx.logger.log(`Cron job completed in ${(end - start).toFixed(2)}ms: ${jobId}`);

					resolve(response);
				} catch (error) {
					// F5 · a cron workflow with a `wait` step (or a scheduling
					// gate) throws DeferredDispatchSignal / WaitDispatchRequest
					// to defer the run — that's a successful deferral, NOT a
					// failure. TriggerBase.run already marked the run
					// delayed/queued/debounced and (for HTTP) persisted the
					// dispatch. Cron's in-process scheduler owns the eventual
					// re-fire, so we just record success and don't bump
					// `cron_errors`.
					if (error instanceof DeferredDispatchSignal || error instanceof WaitDispatchRequest) {
						span.setAttribute("success", true);
						span.setAttribute("deferred", true);
						span.setStatus({ code: SpanStatusCode.OK });

						cronExecutions.add(1, {
							env: process.env.NODE_ENV,
							job_id: jobId,
							workflow_name: this.configuration.name,
							manual: String(manual),
							success: "true",
						});

						this.logger.log(`Cron job deferred ${jobId}: ${(error as Error).message}`);
						resolve({ ctx: {} as Context, metrics: {} as MetricsType });
						return;
					}

					const errorMessage = (error as Error).message;

					// Set span error
					span.setAttribute("success", false);
					span.recordException(error as Error);
					span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });

					// Record error metrics
					cronErrors.add(1, {
						env: process.env.NODE_ENV,
						job_id: jobId,
						workflow_name: this.configuration?.name || "unknown",
						manual: String(manual),
					});

					this.logger.error(`Cron job failed ${jobId}: ${errorMessage}`, (error as Error).stack);

					resolve({ ctx: {} as Context, metrics: {} as MetricsType });
				} finally {
					scheduledJob.running = false;
					span.end();
				}
			});
		});
	}
}

export default CronTrigger;
