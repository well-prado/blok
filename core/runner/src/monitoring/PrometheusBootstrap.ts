/**
 * PrometheusBootstrap - Configures OpenTelemetry MeterProvider with PrometheusExporter
 *
 * Uses dynamic imports for @opentelemetry/sdk-metrics and @opentelemetry/exporter-prometheus.
 * Returns null if the packages are not installed (they are optional peer dependencies).
 * Call this once at trigger startup in listen().
 */

import { metrics } from "@opentelemetry/api";
import { buildOtelResource } from "./otelResource";

export interface PrometheusBootstrapConfig {
	serviceName: string;
	serviceVersion?: string;
	port?: number;
	endpoint?: string;
}

export interface PrometheusBootstrapResult {
	metricsHandler: (req: unknown, res: unknown) => void;
	shutdown: () => Promise<void>;
}

// Track whether we've already initialized to avoid double-init warnings
let initialized = false;

/**
 * Bootstrap Prometheus metrics export using OpenTelemetry.
 *
 * Dynamically imports @opentelemetry/sdk-metrics and @opentelemetry/exporter-prometheus.
 * If these packages are not installed, returns null silently.
 *
 * @returns Bootstrap result with metricsHandler and shutdown, or null if packages unavailable
 */
export async function bootstrapPrometheus(
	config: PrometheusBootstrapConfig,
): Promise<PrometheusBootstrapResult | null> {
	if (initialized) {
		return null;
	}

	try {
		// Use variable-based dynamic imports so TypeScript doesn't try to resolve
		// type declarations at compile time — these are optional peer dependencies.
		const exporterPkg = "@opentelemetry/exporter-prometheus";
		const sdkMetricsPkg = "@opentelemetry/sdk-metrics";
		const resourcesPkg = "@opentelemetry/resources";
		const semconvPkg = "@opentelemetry/semantic-conventions";

		const [exporterMod, sdkMod, resourceMod, semconvMod] = await Promise.all([
			import(/* webpackIgnore: true */ exporterPkg),
			import(/* webpackIgnore: true */ sdkMetricsPkg),
			import(/* webpackIgnore: true */ resourcesPkg),
			import(/* webpackIgnore: true */ semconvPkg),
		]);

		const { PrometheusExporter } = exporterMod;
		const { MeterProvider } = sdkMod;
		const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = semconvMod;

		const port = config.port ?? Number.parseInt(process.env.BLOK_METRICS_PORT || "9464", 10);
		const endpoint = config.endpoint ?? "/metrics";

		const exporter = new PrometheusExporter({ port, endpoint });

		const resource = buildOtelResource(resourceMod, {
			[ATTR_SERVICE_NAME]: config.serviceName,
			[ATTR_SERVICE_VERSION]: config.serviceVersion ?? "0.0.1",
		});

		// OTel 2.x removed `addMetricReader()` in favour of a `readers` ctor
		// option. These SDK packages are OPTIONAL dynamic imports, so a user
		// project may still be on 1.x — detect and use whichever exists.
		const meterProvider =
			typeof MeterProvider.prototype?.addMetricReader === "function"
				? (() => {
						const mp = new MeterProvider({ resource });
						mp.addMetricReader(exporter);
						return mp;
					})()
				: new MeterProvider({ resource, readers: [exporter] });
		metrics.setGlobalMeterProvider(meterProvider);

		initialized = true;

		const metricsHandler = exporter.getMetricsRequestHandler.bind(exporter);

		return {
			metricsHandler,
			shutdown: async () => {
				await meterProvider.shutdown();
				initialized = false;
			},
		};
	} catch {
		// OpenTelemetry SDK packages not installed - this is expected and fine
		return null;
	}
}

/**
 * Reset the initialization state. Useful for testing.
 */
export function resetPrometheusBootstrap(): void {
	initialized = false;
}
