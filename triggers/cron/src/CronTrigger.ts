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

import type { Context, RequestContext } from "@nanoservice-ts/shared";
import {
	TriggerBase,
	NodeMap,
	DefaultLogger,
	type GlobalOptions,
	type TriggerResponse,
	type NanoService,
} from "@nanoservice-ts/runner";
import type { HelperResponse, CronTriggerOpts } from "@nanoservice-ts/helper";
import { trace, metrics, type Span, SpanStatusCode } from "@opentelemetry/api";
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

	// Subclasses provide these
	protected abstract nodes: Record<string, NanoService<unknown>>;
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

				this.logger.log(
					`Scheduling workflow: ${workflow.path} with schedule: ${config.schedule} (${config.timezone})`,
				);

				const job = new CronJob(
					config.schedule,
					async () => {
						await this.executeWorkflow(jobId, workflow, config, false);
					},
					null, // onComplete
					false, // start
					config.timezone,
				);

				const scheduledJob: ScheduledJob = {
					id: jobId,
					workflowPath: workflow.path,
					schedule: config.schedule,
					timezone: config.timezone,
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

			this.logger.log(
				`Cron trigger started. ${this.jobs.size} job(s) scheduled`,
			);

			return this.endCounter(startTime);
		} catch (error) {
			this.logger.error(`Failed to start cron trigger: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Stop all cron jobs
	 */
	async stop(): Promise<void> {
		for (const [jobId, scheduledJob] of this.jobs) {
			scheduledJob.job.stop();
			this.logger.log(`Job ${jobId} stopped`);
		}
		this.jobs.clear();
		this.logger.log("Cron trigger stopped");
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
			return { ctx: {} as Context, metrics: {} as any };
		}

		const executionId = uuid();
		const lastDate = scheduledJob.job.lastDate();
		const scheduledTime = lastDate ? new Date(lastDate as unknown as string | number) : new Date();
		const executionTime = new Date();

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
						timezone: config.timezone,
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
					ctx.vars["_cron_context"] = {
						jobId,
						scheduledTime: scheduledTime.toISOString(),
						executionTime: executionTime.toISOString(),
						schedule: config.schedule,
						timezone: config.timezone,
						manual: String(manual),
					};

					ctx.logger.log(
						`Executing cron job: ${jobId} (${manual ? "manual" : "scheduled"})`,
					);

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
					span.setAttribute("timezone", config.timezone);
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

					ctx.logger.log(
						`Cron job completed in ${(end - start).toFixed(2)}ms: ${jobId}`,
					);

					resolve(response);
				} catch (error) {
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

					this.logger.error(
						`Cron job failed ${jobId}: ${errorMessage}`,
						(error as Error).stack,
					);

					resolve({ ctx: {} as Context, metrics: {} as any });
				} finally {
					scheduledJob.running = false;
					span.end();
				}
			});
		});
	}
}

export default CronTrigger;
