/**
 * AWS CloudWatch Integration for Blok
 *
 * Sends metrics to CloudWatch Metrics and logs to CloudWatch Logs.
 * Traces are exported via OTLP to the AWS Distro for OpenTelemetry (ADOT)
 * Collector, which forwards them to AWS X-Ray.
 *
 * Uses lazy dynamic imports so AWS SDK packages are optional peer
 * dependencies.  If the SDK is not installed the integration silently
 * degrades (init returns false).
 *
 * Supported transports:
 * - **Metrics** – CloudWatch PutMetricData (via @aws-sdk/client-cloudwatch)
 * - **Logs**    – CloudWatch Logs PutLogEvents (via @aws-sdk/client-cloudwatch-logs)
 * - **Traces**  – OTLP → ADOT Collector → X-Ray (reuses TracingBootstrap)
 *
 * @example
 * ```typescript
 * import { CloudWatchIntegration } from "@blok/runner";
 *
 * const cw = new CloudWatchIntegration({
 *   region: "us-east-1",
 *   serviceName: "blok-http",
 *   logGroupName: "/blok/workflows",
 *   namespace: "Blok",
 * });
 *
 * await cw.init();
 *
 * // Send a custom metric
 * await cw.putMetric("WorkflowDuration", 42, "Milliseconds");
 *
 * // Send a structured log entry
 * await cw.putLog({ level: "info", message: "workflow completed", workflowName: "get-user" });
 *
 * // Enable OTLP traces via ADOT Collector
 * const cw = new CloudWatchIntegration({
 *   region: "us-east-1",
 *   serviceName: "blok-http",
 *   enableTracing: true,
 *   adotEndpoint: "http://localhost:4318/v1/traces",
 * });
 * ```
 */

export interface CloudWatchConfig {
	/** AWS region (e.g. "us-east-1"). Falls back to AWS_REGION env var. */
	region?: string;
	/** Blok service name (used in metric dimensions and log metadata) */
	serviceName: string;
	/** Service version */
	serviceVersion?: string;
	/** Environment label */
	environment?: string;

	/* ---- CloudWatch Logs ---- */
	/** CloudWatch Logs log group name (default: "/blok/workflows") */
	logGroupName?: string;
	/** CloudWatch Logs log stream name (default: serviceName-<date>) */
	logStreamName?: string;

	/* ---- CloudWatch Metrics ---- */
	/** CloudWatch Metrics namespace (default: "Blok") */
	namespace?: string;

	/* ---- Traces via ADOT ---- */
	/** Enable OTLP trace export via ADOT Collector → X-Ray */
	enableTracing?: boolean;
	/** ADOT Collector OTLP endpoint (default: http://localhost:4318/v1/traces) */
	adotEndpoint?: string;
	/** Trace sampling ratio (0.0 – 1.0, default: 1.0) */
	samplingRatio?: number;

	/** Enable debug logging */
	debug?: boolean;
}

/** Supported CloudWatch metric units */
export type CloudWatchUnit =
	| "Seconds"
	| "Microseconds"
	| "Milliseconds"
	| "Bytes"
	| "Kilobytes"
	| "Megabytes"
	| "Gigabytes"
	| "Bits"
	| "Percent"
	| "Count"
	| "Count/Second"
	| "None";

export interface CloudWatchLogEntry {
	level: "debug" | "info" | "warn" | "error" | "fatal";
	message: string;
	[key: string]: unknown;
}

export interface CloudWatchStats {
	initialized: boolean;
	metricsPublished: number;
	logsPublished: number;
	metricErrors: number;
	logErrors: number;
	tracingEnabled: boolean;
}

/* ---------- Minimal AWS SDK type stubs (avoid hard dep on @aws-sdk/*) ---------- */

interface CWClient {
	send(command: unknown): Promise<unknown>;
}

interface CWLogsClient {
	send(command: unknown): Promise<{ nextSequenceToken?: string }>;
}

export class CloudWatchIntegration {
	private config: Required<Pick<CloudWatchConfig, "serviceName" | "logGroupName" | "namespace">> & CloudWatchConfig;

	private cwClient: CWClient | null = null;
	private cwLogsClient: CWLogsClient | null = null;
	private initialized = false;
	private tracingInitialized = false;
	private tracingShutdown: (() => Promise<void>) | null = null;
	private sequenceToken: string | undefined;

	// SDK constructors (loaded lazily)
	private PutMetricDataCommand: (new (input: unknown) => unknown) | null = null;
	private PutLogEventsCommand: (new (input: unknown) => unknown) | null = null;
	private CreateLogGroupCommand: (new (input: unknown) => unknown) | null = null;
	private CreateLogStreamCommand: (new (input: unknown) => unknown) | null = null;

	// stats
	private metricsPublished = 0;
	private logsPublished = 0;
	private metricErrors = 0;
	private logErrors = 0;

	constructor(config: CloudWatchConfig) {
		this.config = {
			region: process.env.AWS_REGION || "us-east-1",
			serviceVersion: "0.0.1",
			environment: process.env.NODE_ENV || "development",
			logGroupName: "/blok/workflows",
			namespace: "Blok",
			enableTracing: false,
			adotEndpoint: "http://localhost:4318/v1/traces",
			samplingRatio: 1.0,
			debug: false,
			...config,
		};
	}

	/**
	 * Initialize CloudWatch clients.
	 * Returns false if AWS SDK packages are not installed.
	 */
	async init(): Promise<boolean> {
		if (this.initialized) return true;

		try {
			// Dynamically load AWS SDK v3 packages
			// @ts-expect-error: optional peer dependency
			const cwMod = await import("@aws-sdk/client-cloudwatch");
			// @ts-expect-error: optional peer dependency
			const cwLogsMod = await import("@aws-sdk/client-cloudwatch-logs");

			const regionConfig = { region: this.config.region };

			this.cwClient = new cwMod.CloudWatchClient(regionConfig) as CWClient;
			this.cwLogsClient = new cwLogsMod.CloudWatchLogsClient(regionConfig) as CWLogsClient;

			this.PutMetricDataCommand = cwMod.PutMetricDataCommand;
			this.PutLogEventsCommand = cwLogsMod.PutLogEventsCommand;
			this.CreateLogGroupCommand = cwLogsMod.CreateLogGroupCommand;
			this.CreateLogStreamCommand = cwLogsMod.CreateLogStreamCommand;

			// Ensure log group & stream exist
			await this.ensureLogDestination();

			this.initialized = true;

			// Optionally bootstrap OTLP tracing for X-Ray via ADOT
			if (this.config.enableTracing) {
				await this.initTracing();
			}

			return true;
		} catch {
			// AWS SDK packages not installed — degrade gracefully
			return false;
		}
	}

	/* ------------------------------------------------------------------ */
	/*  Metrics                                                           */
	/* ------------------------------------------------------------------ */

	/**
	 * Publish a custom metric to CloudWatch.
	 */
	async putMetric(
		metricName: string,
		value: number,
		unit: CloudWatchUnit = "None",
		dimensions?: Record<string, string>,
	): Promise<boolean> {
		if (!this.cwClient || !this.PutMetricDataCommand) return false;

		try {
			const dims = {
				Service: this.config.serviceName,
				Environment: this.config.environment || "development",
				...dimensions,
			};

			const command = new this.PutMetricDataCommand({
				Namespace: this.config.namespace,
				MetricData: [
					{
						MetricName: metricName,
						Value: value,
						Unit: unit,
						Timestamp: new Date(),
						Dimensions: Object.entries(dims).map(([Name, Value]) => ({
							Name,
							Value,
						})),
					},
				],
			});

			await this.cwClient.send(command);
			this.metricsPublished++;
			return true;
		} catch {
			this.metricErrors++;
			return false;
		}
	}

	/**
	 * Publish workflow execution metrics (duration + error count).
	 */
	async recordWorkflowExecution(workflowName: string, durationMs: number, success: boolean): Promise<void> {
		await this.putMetric("WorkflowDuration", durationMs, "Milliseconds", {
			Workflow: workflowName,
		});

		if (!success) {
			await this.putMetric("WorkflowErrors", 1, "Count", {
				Workflow: workflowName,
			});
		}
	}

	/* ------------------------------------------------------------------ */
	/*  Logs                                                              */
	/* ------------------------------------------------------------------ */

	/**
	 * Send a structured log entry to CloudWatch Logs.
	 */
	async putLog(entry: CloudWatchLogEntry): Promise<boolean> {
		if (!this.cwLogsClient || !this.PutLogEventsCommand) return false;

		try {
			const event = {
				timestamp: Date.now(),
				message: JSON.stringify({
					...entry,
					service: this.config.serviceName,
					version: this.config.serviceVersion,
					environment: this.config.environment,
				}),
			};

			const command = new this.PutLogEventsCommand({
				logGroupName: this.config.logGroupName,
				logStreamName: this.getLogStreamName(),
				logEvents: [event],
				sequenceToken: this.sequenceToken,
			});

			const result = await this.cwLogsClient.send(command);
			this.sequenceToken = result?.nextSequenceToken;
			this.logsPublished++;
			return true;
		} catch {
			this.logErrors++;
			return false;
		}
	}

	/**
	 * Log a workflow error to CloudWatch Logs.
	 */
	async logWorkflowError(
		error: Error,
		context: {
			workflowName: string;
			workflowPath: string;
			requestId?: string;
			nodeName?: string;
		},
	): Promise<boolean> {
		return this.putLog({
			level: "error",
			message: error.message,
			errorName: error.name,
			stack: error.stack,
			...context,
		});
	}

	/* ------------------------------------------------------------------ */
	/*  Tracing (OTLP → ADOT → X-Ray)                                    */
	/* ------------------------------------------------------------------ */

	private async initTracing(): Promise<boolean> {
		try {
			const { bootstrapTracing } = await import("../monitoring/TracingBootstrap");

			const result = await bootstrapTracing({
				serviceName: this.config.serviceName,
				serviceVersion: this.config.serviceVersion,
				exporter: "otlp",
				endpoint: this.config.adotEndpoint || "http://localhost:4318/v1/traces",
				headers: {},
				samplingRatio: this.config.samplingRatio,
			});

			if (!result) return false;

			this.tracingShutdown = result.shutdown;
			this.tracingInitialized = true;
			return true;
		} catch {
			return false;
		}
	}

	/* ------------------------------------------------------------------ */
	/*  Lifecycle                                                         */
	/* ------------------------------------------------------------------ */

	isInitialized(): boolean {
		return this.initialized;
	}

	isTracingEnabled(): boolean {
		return this.tracingInitialized;
	}

	getStats(): CloudWatchStats {
		return {
			initialized: this.initialized,
			metricsPublished: this.metricsPublished,
			logsPublished: this.logsPublished,
			metricErrors: this.metricErrors,
			logErrors: this.logErrors,
			tracingEnabled: this.tracingInitialized,
		};
	}

	async shutdown(): Promise<void> {
		if (this.tracingShutdown) {
			await this.tracingShutdown();
		}
		this.initialized = false;
		this.tracingInitialized = false;
	}

	async flush(): Promise<void> {
		// CloudWatch SDK calls are fire-and-forget; nothing buffered to flush.
		// Tracing flush is handled by TracingBootstrap.
	}

	/* ------------------------------------------------------------------ */
	/*  Internal helpers                                                  */
	/* ------------------------------------------------------------------ */

	private getLogStreamName(): string {
		if (this.config.logStreamName) return this.config.logStreamName;

		const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
		return `${this.config.serviceName}-${date}`;
	}

	private async ensureLogDestination(): Promise<void> {
		if (!this.cwLogsClient || !this.CreateLogGroupCommand || !this.CreateLogStreamCommand) return;

		try {
			await this.cwLogsClient.send(new this.CreateLogGroupCommand({ logGroupName: this.config.logGroupName }));
		} catch {
			// ResourceAlreadyExistsException is expected
		}

		try {
			await this.cwLogsClient.send(
				new this.CreateLogStreamCommand({
					logGroupName: this.config.logGroupName,
					logStreamName: this.getLogStreamName(),
				}),
			);
		} catch {
			// ResourceAlreadyExistsException is expected
		}
	}
}
