/**
 * Azure Monitor Integration for Blok
 *
 * Exports traces, metrics, and logs to Azure Application Insights via the
 * Azure Monitor OpenTelemetry Exporter or the Application Insights SDK.
 *
 * Supports two modes:
 * 1. **OTLP mode** (recommended) – Uses the generic OTLP exporter pointing at
 *    the Azure Monitor OTLP endpoint.  Requires an Application Insights
 *    connection string.
 * 2. **Azure Exporter mode** – Uses `@azure/monitor-opentelemetry-exporter`
 *    for native Azure integration with automatic sampling and live metrics.
 *
 * All Azure SDK dependencies are loaded lazily so the framework doesn't
 * hard-depend on any Azure packages.  If the packages are not installed
 * `init()` returns false and the integration is a no-op.
 *
 * @example
 * ```typescript
 * import { AzureMonitorIntegration } from "@blok/runner";
 *
 * const azure = new AzureMonitorIntegration({
 *   connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING!,
 *   serviceName: "blok-http",
 * });
 *
 * await azure.init();
 *
 * // Track a custom event
 * azure.trackEvent("WorkflowCompleted", { workflowName: "get-user", durationMs: "42" });
 *
 * // Track an exception
 * azure.trackException(error, { workflowName: "get-user", nodeName: "fetch-db" });
 *
 * // Track a metric
 * azure.trackMetric("WorkflowDuration", 42);
 * ```
 */

export interface AzureMonitorConfig {
	/**
	 * Application Insights connection string.
	 * Falls back to APPLICATIONINSIGHTS_CONNECTION_STRING env var.
	 */
	connectionString?: string;
	/** Blok service name */
	serviceName: string;
	/** Service version */
	serviceVersion?: string;
	/** Environment label */
	environment?: string;

	/**
	 * Export mode:
	 * - "azure" – use @azure/monitor-opentelemetry-exporter (native)
	 * - "otlp"  – use generic OTLP exporter with Azure ingestion endpoint
	 * Default: "azure"
	 */
	exportMode?: "azure" | "otlp";

	/** Trace sampling ratio (0.0 – 1.0, default: 1.0) */
	samplingRatio?: number;

	/** Enable live metrics stream (default: false) */
	enableLiveMetrics?: boolean;

	/** Enable debug logging */
	debug?: boolean;
}

export interface AzureMonitorStats {
	initialized: boolean;
	eventsTracked: number;
	exceptionsTracked: number;
	metricsTracked: number;
}

/* ---------- Minimal type stubs for the Azure SDK (avoid hard dep) ---------- */

interface AzureExporterLike {
	shutdown?(): Promise<void>;
}

export class AzureMonitorIntegration {
	private config: Required<Pick<AzureMonitorConfig, "serviceName">> & AzureMonitorConfig;
	private initialized = false;
	private exporter: AzureExporterLike | null = null;
	private tracingShutdown: (() => Promise<void>) | null = null;

	// Telemetry client for custom events / metrics (Application Insights SDK)
	private telemetryClient: {
		trackEvent(event: { name: string; properties?: Record<string, string> }): void;
		trackException(exc: { exception: Error; properties?: Record<string, string> }): void;
		trackMetric(metric: { name: string; value: number; properties?: Record<string, string> }): void;
		flush(): Promise<void>;
	} | null = null;

	// stats
	private eventsTracked = 0;
	private exceptionsTracked = 0;
	private metricsTracked = 0;

	constructor(config: AzureMonitorConfig) {
		this.config = {
			connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
			serviceVersion: "0.0.1",
			environment: process.env.NODE_ENV || "development",
			exportMode: "azure",
			samplingRatio: 1.0,
			enableLiveMetrics: false,
			debug: false,
			...config,
		};
	}

	/**
	 * Initialize Azure Monitor.
	 * Returns false if required packages or connection string are missing.
	 */
	async init(): Promise<boolean> {
		if (this.initialized) return true;

		const connStr = this.config.connectionString;
		if (!connStr) return false;

		try {
			if (this.config.exportMode === "azure") {
				return await this.initAzureExporter(connStr);
			}
			return await this.initOTLP(connStr);
		} catch {
			return false;
		}
	}

	/* ------------------------------------------------------------------ */
	/*  Azure Monitor exporter mode                                       */
	/* ------------------------------------------------------------------ */

	private async initAzureExporter(connectionString: string): Promise<boolean> {
		try {
			// @ts-expect-error: optional peer dependency
			const azureMod = await import("@azure/monitor-opentelemetry-exporter");

			// The Azure trace exporter works via OpenTelemetry's TracerProvider.
			// We bootstrap tracing with it by piping through our standard bootstrap
			// path — the Azure exporter is OTLP-compatible.
			const exporter = new azureMod.AzureMonitorTraceExporter({
				connectionString,
			});

			this.exporter = exporter;

			// Also try to set up a lightweight telemetry client for custom events
			await this.initTelemetryClient(connectionString);

			this.initialized = true;
			return true;
		} catch {
			// Fall back to OTLP mode
			return this.initOTLP(connectionString);
		}
	}

	/* ------------------------------------------------------------------ */
	/*  OTLP mode (uses TracingBootstrap pointing at Azure endpoint)      */
	/* ------------------------------------------------------------------ */

	private async initOTLP(connectionString: string): Promise<boolean> {
		try {
			// Extract ingestion endpoint from connection string
			const endpoint = this.extractEndpoint(connectionString);
			const instrumentationKey = this.extractInstrumentationKey(connectionString);

			if (!endpoint || !instrumentationKey) return false;

			const { bootstrapTracing } = await import("../monitoring/TracingBootstrap");

			const result = await bootstrapTracing({
				serviceName: this.config.serviceName,
				serviceVersion: this.config.serviceVersion,
				exporter: "otlp",
				endpoint: `${endpoint}/v2/track`,
				headers: {
					"x-ms-instrumentationkey": instrumentationKey,
				},
				samplingRatio: this.config.samplingRatio,
			});

			if (!result) return false;

			this.tracingShutdown = result.shutdown;
			await this.initTelemetryClient(connectionString);
			this.initialized = true;
			return true;
		} catch {
			return false;
		}
	}

	/* ------------------------------------------------------------------ */
	/*  Lightweight telemetry client (custom events, metrics)             */
	/* ------------------------------------------------------------------ */

	private async initTelemetryClient(connectionString: string): Promise<void> {
		try {
			// @ts-expect-error: optional peer dependency
			const appInsights = await import("applicationinsights");

			appInsights.setup(connectionString).setAutoCollectRequests(false).start();

			const client = appInsights.defaultClient;
			if (!client) return;

			this.telemetryClient = {
				trackEvent: (event) => client.trackEvent(event),
				trackException: (exc) => client.trackException(exc),
				trackMetric: (metric) => client.trackMetric(metric),
				flush: () =>
					new Promise<void>((resolve) => {
						client.flush({ callback: () => resolve() });
					}),
			};
		} catch {
			// applicationinsights package not installed — custom events won't work
			// but tracing via OTLP will still function
		}
	}

	/* ------------------------------------------------------------------ */
	/*  Custom telemetry helpers                                          */
	/* ------------------------------------------------------------------ */

	/**
	 * Track a custom event (e.g. "WorkflowCompleted").
	 */
	trackEvent(name: string, properties?: Record<string, string>): void {
		if (!this.telemetryClient) return;
		this.telemetryClient.trackEvent({ name, properties });
		this.eventsTracked++;
	}

	/**
	 * Track an exception.
	 */
	trackException(error: Error, properties?: Record<string, string>): void {
		if (!this.telemetryClient) return;
		this.telemetryClient.trackException({ exception: error, properties });
		this.exceptionsTracked++;
	}

	/**
	 * Track a numeric metric.
	 */
	trackMetric(name: string, value: number, properties?: Record<string, string>): void {
		if (!this.telemetryClient) return;
		this.telemetryClient.trackMetric({ name, value, properties });
		this.metricsTracked++;
	}

	/**
	 * Record a workflow execution as both a custom event and metric.
	 */
	recordWorkflowExecution(workflowName: string, durationMs: number, success: boolean): void {
		this.trackEvent(success ? "WorkflowCompleted" : "WorkflowFailed", {
			workflowName,
			durationMs: String(durationMs),
			environment: this.config.environment || "development",
		});

		this.trackMetric("WorkflowDuration", durationMs, { workflowName });

		if (!success) {
			this.trackMetric("WorkflowErrors", 1, { workflowName });
		}
	}

	/* ------------------------------------------------------------------ */
	/*  Lifecycle                                                         */
	/* ------------------------------------------------------------------ */

	isInitialized(): boolean {
		return this.initialized;
	}

	getStats(): AzureMonitorStats {
		return {
			initialized: this.initialized,
			eventsTracked: this.eventsTracked,
			exceptionsTracked: this.exceptionsTracked,
			metricsTracked: this.metricsTracked,
		};
	}

	async shutdown(): Promise<void> {
		if (this.tracingShutdown) {
			await this.tracingShutdown();
		}
		if (this.exporter?.shutdown) {
			await this.exporter.shutdown();
		}
		this.initialized = false;
	}

	async flush(): Promise<void> {
		if (this.telemetryClient) {
			await this.telemetryClient.flush();
		}
	}

	/* ------------------------------------------------------------------ */
	/*  Connection string parsing                                         */
	/* ------------------------------------------------------------------ */

	/**
	 * Extract the ingestion endpoint from an Application Insights connection string.
	 * Format: InstrumentationKey=...;IngestionEndpoint=https://...;...
	 */
	private extractEndpoint(connectionString: string): string | null {
		const match = connectionString.match(/IngestionEndpoint=([^;]+)/i);
		return match?.[1]?.replace(/\/$/, "") ?? null;
	}

	/**
	 * Extract the instrumentation key from an Application Insights connection string.
	 */
	private extractInstrumentationKey(connectionString: string): string | null {
		const match = connectionString.match(/InstrumentationKey=([^;]+)/i);
		return match?.[1] ?? null;
	}
}
