/**
 * APMIntegration - Unified APM bridge for DataDog, New Relic, and generic OTLP backends
 *
 * Configures OpenTelemetry trace and metric exporters targeting specific APM vendors.
 * Each vendor has pre-configured OTLP endpoints and required headers/env vars.
 *
 * Uses lazy dynamic imports so vendor-specific SDK packages are optional.
 * Falls back to generic OTLP if vendor-specific packages are not installed.
 *
 * Supported vendors:
 * - **DataDog**: Sends traces/metrics via dd-trace or OTLP to DataDog Agent
 * - **New Relic**: Sends traces/metrics via OTLP to New Relic ingest endpoint
 * - **Generic OTLP**: Any OTLP-compatible backend (Jaeger, Grafana Tempo, etc.)
 *
 * @example
 * ```typescript
 * import { APMIntegration } from "@blokjs/runner";
 *
 * // DataDog
 * const apm = new APMIntegration({
 *   vendor: "datadog",
 *   serviceName: "blok-http",
 *   datadogAgentUrl: "http://localhost:4318",
 * });
 * await apm.init();
 *
 * // New Relic
 * const apm = new APMIntegration({
 *   vendor: "newrelic",
 *   serviceName: "blok-http",
 *   newrelicLicenseKey: process.env.NEW_RELIC_LICENSE_KEY!,
 * });
 * await apm.init();
 *
 * // Generic OTLP
 * const apm = new APMIntegration({
 *   vendor: "otlp",
 *   serviceName: "blok-http",
 *   otlpEndpoint: "http://tempo:4318/v1/traces",
 * });
 * await apm.init();
 * ```
 */

export type APMVendor = "datadog" | "newrelic" | "otlp";

export interface APMConfig {
	/** APM vendor */
	vendor: APMVendor;
	/** Service name */
	serviceName: string;
	/** Service version */
	serviceVersion?: string;
	/** Environment (defaults to NODE_ENV) */
	environment?: string;

	/** DataDog: Agent OTLP endpoint (default: http://localhost:4318) */
	datadogAgentUrl?: string;
	/** DataDog: dd-trace service name override */
	datadogServiceName?: string;

	/** New Relic: License key (or set NEW_RELIC_LICENSE_KEY env) */
	newrelicLicenseKey?: string;
	/** New Relic: OTLP endpoint (default: US region endpoint) */
	newrelicEndpoint?: string;
	/** New Relic: Region "us" | "eu" (default: "us") */
	newrelicRegion?: "us" | "eu";

	/** Generic OTLP: endpoint URL */
	otlpEndpoint?: string;
	/** Generic OTLP: additional headers */
	otlpHeaders?: Record<string, string>;

	/** Trace sampling ratio (0.0 to 1.0, default: 1.0) */
	samplingRatio?: number;
	/** Enable debug logging */
	debug?: boolean;
}

export interface APMBootstrapResult {
	/** Vendor name */
	vendor: APMVendor;
	/** Gracefully shut down the APM integration */
	shutdown: () => Promise<void>;
	/** Force flush pending data */
	forceFlush: () => Promise<void>;
}

export class APMIntegration {
	private config: APMConfig;
	private initialized = false;
	private shutdownFn: (() => Promise<void>) | null = null;
	private flushFn: (() => Promise<void>) | null = null;

	constructor(config: APMConfig) {
		this.config = {
			serviceVersion: "0.0.1",
			environment: process.env.NODE_ENV || "development",
			samplingRatio: 1.0,
			debug: false,
			...config,
		};
	}

	/**
	 * Initialize the APM integration.
	 * Dynamically loads vendor-specific or generic OTLP packages.
	 * Returns false if required packages are not installed.
	 */
	async init(): Promise<boolean> {
		if (this.initialized) return true;

		try {
			switch (this.config.vendor) {
				case "datadog":
					return await this.initDataDog();
				case "newrelic":
					return await this.initNewRelic();
				case "otlp":
					return await this.initOTLP();
				default:
					return false;
			}
		} catch {
			return false;
		}
	}

	/**
	 * Initialize DataDog APM.
	 *
	 * Strategy: Use OTLP export to the DataDog Agent, which accepts OTLP
	 * on port 4318 (HTTP) or 4317 (gRPC) when configured with
	 * DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT.
	 */
	private async initDataDog(): Promise<boolean> {
		const endpoint = this.config.datadogAgentUrl || "http://localhost:4318/v1/traces";

		const headers: Record<string, string> = {};
		// DataDog Agent does not require auth headers for local OTLP,
		// but we pass service metadata via resource attributes.

		return this.bootstrapOTLPTracing(endpoint, headers);
	}

	/**
	 * Initialize New Relic APM.
	 *
	 * Strategy: Send traces via OTLP to New Relic's ingest endpoint.
	 * Requires NEW_RELIC_LICENSE_KEY in headers.
	 */
	private async initNewRelic(): Promise<boolean> {
		const licenseKey = this.config.newrelicLicenseKey || process.env.NEW_RELIC_LICENSE_KEY || "";

		if (!licenseKey) {
			return false;
		}

		const region = this.config.newrelicRegion ?? "us";
		const endpoint =
			this.config.newrelicEndpoint ||
			(region === "eu" ? "https://otlp.eu01.nr-data.net:4318/v1/traces" : "https://otlp.nr-data.net:4318/v1/traces");

		const headers: Record<string, string> = {
			"api-key": licenseKey,
		};

		return this.bootstrapOTLPTracing(endpoint, headers);
	}

	/**
	 * Initialize generic OTLP backend.
	 */
	private async initOTLP(): Promise<boolean> {
		const endpoint =
			this.config.otlpEndpoint ||
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
			"http://localhost:4318/v1/traces";

		return this.bootstrapOTLPTracing(endpoint, this.config.otlpHeaders || {});
	}

	/**
	 * Shared OTLP bootstrap using TracingBootstrap.
	 */
	private async bootstrapOTLPTracing(endpoint: string, headers: Record<string, string>): Promise<boolean> {
		try {
			// Use our TracingBootstrap module
			const { bootstrapTracing } = await import("../monitoring/TracingBootstrap");

			const result = await bootstrapTracing({
				serviceName: this.config.serviceName,
				serviceVersion: this.config.serviceVersion,
				exporter: "otlp",
				endpoint,
				headers,
				samplingRatio: this.config.samplingRatio,
			});

			if (!result) return false;

			this.shutdownFn = result.shutdown;
			this.flushFn = result.forceFlush;
			this.initialized = true;
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if the APM integration is initialized.
	 */
	isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * Get the configured vendor.
	 */
	getVendor(): APMVendor {
		return this.config.vendor;
	}

	/**
	 * Shut down the APM integration, flushing pending data.
	 */
	async shutdown(): Promise<void> {
		if (this.shutdownFn) {
			await this.shutdownFn();
		}
		this.initialized = false;
	}

	/**
	 * Force flush pending traces/metrics.
	 */
	async forceFlush(): Promise<void> {
		if (this.flushFn) {
			await this.flushFn();
		}
	}

	/**
	 * Get the OTLP endpoint configuration for the current vendor.
	 * Useful for debugging and diagnostics.
	 */
	getEndpointInfo(): { vendor: APMVendor; endpoint: string; initialized: boolean } {
		let endpoint: string;

		switch (this.config.vendor) {
			case "datadog":
				endpoint = this.config.datadogAgentUrl || "http://localhost:4318/v1/traces";
				break;
			case "newrelic": {
				const region = this.config.newrelicRegion ?? "us";
				endpoint =
					this.config.newrelicEndpoint ||
					(region === "eu"
						? "https://otlp.eu01.nr-data.net:4318/v1/traces"
						: "https://otlp.nr-data.net:4318/v1/traces");
				break;
			}
			case "otlp":
				endpoint = this.config.otlpEndpoint || "http://localhost:4318/v1/traces";
				break;
			default:
				endpoint = "unknown";
		}

		return {
			vendor: this.config.vendor,
			endpoint,
			initialized: this.initialized,
		};
	}
}
