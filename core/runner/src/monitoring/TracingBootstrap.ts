/**
 * TracingBootstrap - Configures OpenTelemetry TracerProvider with OTLP/Jaeger/Zipkin exporters
 *
 * Uses dynamic imports for @opentelemetry/sdk-trace-node, OTLP exporter, etc.
 * Returns null if the packages are not installed (they are optional peer dependencies).
 * Call this once at trigger startup in listen().
 *
 * Supports multiple exporter backends:
 * - OTLP (gRPC or HTTP) — works with Jaeger, Tempo, DataDog, New Relic, etc.
 * - Console — for development/debugging
 *
 * @example
 * ```typescript
 * import { bootstrapTracing } from "@blokjs/runner";
 *
 * const result = await bootstrapTracing({
 *   serviceName: "blok-http",
 *   exporter: "otlp",
 *   endpoint: "http://localhost:4318/v1/traces",
 * });
 *
 * if (result) {
 *   process.on("SIGTERM", result.shutdown);
 * }
 * ```
 */

import { trace } from "@opentelemetry/api";
import { buildOtelResource } from "./otelResource";

export type TracingExporterType = "otlp" | "console";

export interface TracingBootstrapConfig {
	/** Service name used in Resource attributes */
	serviceName: string;
	/** Service version (default: "0.0.1") */
	serviceVersion?: string;
	/** Exporter type (default: "otlp") */
	exporter?: TracingExporterType;
	/**
	 * OTLP endpoint URL (default: env OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
	 * or "http://localhost:4318/v1/traces")
	 */
	endpoint?: string;
	/** OTLP protocol: "http/protobuf" | "grpc" (default: "http/protobuf") */
	protocol?: "http/protobuf" | "grpc";
	/** Additional OTLP headers (e.g., auth tokens for DataDog/New Relic) */
	headers?: Record<string, string>;
	/** Sampling ratio (0.0 to 1.0, default: 1.0) */
	samplingRatio?: number;
	/** Max batch export delay in ms (default: 5000) */
	batchExportDelayMs?: number;
	/** Max export batch size (default: 512) */
	maxExportBatchSize?: number;
}

export interface TracingBootstrapResult {
	/** Graceful shutdown — flushes pending spans and shuts down the provider */
	shutdown: () => Promise<void>;
	/** Force flush pending spans */
	forceFlush: () => Promise<void>;
}

let initialized = false;

/**
 * Bootstrap distributed tracing using OpenTelemetry.
 *
 * Dynamically imports @opentelemetry/sdk-trace-node and the selected exporter.
 * If the packages are not installed, returns null silently.
 *
 * @returns Bootstrap result with shutdown/flush, or null if packages unavailable
 */
export async function bootstrapTracing(config: TracingBootstrapConfig): Promise<TracingBootstrapResult | null> {
	if (initialized) {
		return null;
	}

	try {
		const exporterType = config.exporter ?? "otlp";
		const protocol = config.protocol ?? "http/protobuf";

		// Dynamic imports — these are optional peer dependencies
		const sdkTracePkg = "@opentelemetry/sdk-trace-node";
		const resourcesPkg = "@opentelemetry/resources";
		const semconvPkg = "@opentelemetry/semantic-conventions";

		const [sdkMod, resourceMod, semconvMod] = await Promise.all([
			import(/* webpackIgnore: true */ sdkTracePkg),
			import(/* webpackIgnore: true */ resourcesPkg),
			import(/* webpackIgnore: true */ semconvPkg),
		]);

		const { NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter } = sdkMod;
		const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = semconvMod;

		// Build resource (1.x class vs 2.x factory — see otelResource.ts)
		const resource = buildOtelResource(resourceMod, {
			[ATTR_SERVICE_NAME]: config.serviceName,
			[ATTR_SERVICE_VERSION]: config.serviceVersion ?? "0.0.1",
		});

		// Create the appropriate exporter
		let spanExporter: unknown;
		let spanProcessor: unknown;

		if (exporterType === "console") {
			spanExporter = new ConsoleSpanExporter();
			spanProcessor = new SimpleSpanProcessor(spanExporter);
		} else {
			// OTLP exporter
			const endpoint =
				config.endpoint ||
				process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
				process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
				"http://localhost:4318/v1/traces";

			if (protocol === "grpc") {
				const grpcPkg = "@opentelemetry/exporter-trace-otlp-grpc";
				const grpcMod = await import(/* webpackIgnore: true */ grpcPkg);
				spanExporter = new grpcMod.OTLPTraceExporter({
					url: endpoint,
					headers: config.headers,
				});
			} else {
				const httpPkg = "@opentelemetry/exporter-trace-otlp-http";
				const httpMod = await import(/* webpackIgnore: true */ httpPkg);
				spanExporter = new httpMod.OTLPTraceExporter({
					url: endpoint,
					headers: config.headers,
				});
			}

			spanProcessor = new BatchSpanProcessor(spanExporter, {
				maxExportBatchSize: config.maxExportBatchSize ?? 512,
				scheduledDelayMillis: config.batchExportDelayMs ?? 5000,
			});
		}

		// Create provider with optional sampling
		const providerConfig: Record<string, unknown> = { resource };
		if (config.samplingRatio !== undefined && config.samplingRatio < 1.0) {
			const { TraceIdRatioBasedSampler } = sdkMod;
			providerConfig.sampler = new TraceIdRatioBasedSampler(config.samplingRatio);
		}

		// OTel 2.x removed `addSpanProcessor()` in favour of a `spanProcessors`
		// ctor option. These SDK packages are OPTIONAL dynamic imports, so a user
		// project may still be on 1.x — detect and use whichever exists.
		const provider =
			typeof NodeTracerProvider.prototype?.addSpanProcessor === "function"
				? (() => {
						const p = new NodeTracerProvider(providerConfig);
						p.addSpanProcessor(spanProcessor);
						return p;
					})()
				: new NodeTracerProvider({ ...providerConfig, spanProcessors: [spanProcessor] });

		// Register globally so `trace.getTracer()` picks up this provider
		provider.register();
		initialized = true;

		return {
			shutdown: async () => {
				// `provider.shutdown()` force-flushes queued spans through the OTLP
				// exporter. Against an unreachable collector the exporter retries, so
				// an unbounded await blocks graceful shutdown (SIGTERM) indefinitely —
				// the process never exits. Cap the flush and move on; dropping a few
				// unexported spans beats hanging the deployment. Tune via
				// BLOK_TRACING_SHUTDOWN_TIMEOUT_MS.
				const timeoutMs = Number.parseInt(process.env.BLOK_TRACING_SHUTDOWN_TIMEOUT_MS || "2000", 10);
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						provider.shutdown(),
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, timeoutMs);
						}),
					]);
				} catch {
					// Exporter failures on shutdown are non-fatal — never block exit.
				} finally {
					if (timer) clearTimeout(timer);
					initialized = false;
				}
			},
			forceFlush: async () => {
				await provider.forceFlush();
			},
		};
	} catch {
		// OpenTelemetry SDK packages not installed — this is expected and fine
		return null;
	}
}

/**
 * Reset the initialization state. Useful for testing.
 */
export function resetTracingBootstrap(): void {
	// Also disable the global tracer provider so a fresh one can be registered
	trace.disable();
	initialized = false;
}
