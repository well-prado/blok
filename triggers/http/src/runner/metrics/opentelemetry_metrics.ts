import type { IncomingMessage, ServerResponse } from "node:http";
import { DefaultLogger } from "@blokjs/runner";
import { type Meter, metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/** The OTel Prometheus exporter's request handler — raw Node req/res. */
type MetricsRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface MetricsBootstrap {
	meter: Meter;
	metricsHandler: MetricsRequestHandler;
}

let _bootstrap: MetricsBootstrap | null = null;
let _initialized = false;

/**
 * Lazily-populated, back-compat exports — `undefined` until `bootstrapMetrics()`
 * runs (and forever `undefined` when metrics are disabled). ESM live bindings,
 * so importers see the values once bootstrap completes. The only in-tree
 * consumer (HttpTrigger) reads the bootstrap return value instead, so these
 * exist purely so any stray module-level importer keeps resolving.
 */
export let meter: Meter | undefined;
export let metricsHandler: MetricsRequestHandler | undefined;

/**
 * Install the Prometheus exporter + the global OTel `MeterProvider`, returning
 * the `/metrics` request handler — or `null` when `BLOK_METRICS_DISABLED=1`.
 *
 * THE METRICS OPT-OUT GATE. Metrics are ON by default (backward compatible);
 * setting `BLOK_METRICS_DISABLED=1` skips this entirely — no exporter is built
 * and NO global `MeterProvider` is installed, so every `blok_*` instrument
 * (created via `metrics.getMeter(...)`) falls back to OTel's no-op meter and
 * records nothing. The caller (HttpTrigger.listen) then also skips registering
 * the `/metrics` route. There is intentionally NO module-load side-effect — the
 * provider is installed only when this is explicitly called (previously it ran
 * at import time + via a Dockerfile `--preload`, which made it impossible to
 * turn off). Idempotent: repeated calls return the first result.
 */
export async function bootstrapMetrics(): Promise<MetricsBootstrap | null> {
	if (_initialized) return _bootstrap;
	_initialized = true;

	if (process.env.BLOK_METRICS_DISABLED === "1") {
		_bootstrap = null;
		return null;
	}

	const prometheusExporter = new PrometheusExporter({}, () =>
		new DefaultLogger().log("Metrics endpoint: http://localhost:4000/metrics"),
	);

	const resource = defaultResource().merge(
		resourceFromAttributes({
			[ATTR_SERVICE_NAME]: "trigger-http",
			[ATTR_SERVICE_VERSION]: "0.0.8",
		}),
	);

	// OTel 2.x: readers are supplied to the ctor (`addMetricReader` was removed).
	const meterProvider = new MeterProvider({ resource, readers: [prometheusExporter] });
	metrics.setGlobalMeterProvider(meterProvider);

	// Local consts (non-undefined) for the returned bootstrap; the module-level
	// `let` exports mirror them for the lazy back-compat bindings.
	const m = metrics.getMeter("default");
	const handler: MetricsRequestHandler = prometheusExporter.getMetricsRequestHandler.bind(prometheusExporter);
	meter = m;
	metricsHandler = handler;
	_bootstrap = { meter: m, metricsHandler: handler };
	return _bootstrap;
}

/** Test-only: clear bootstrap state so a fresh `BLOK_METRICS_DISABLED` is honored. */
export function resetBootstrap(): void {
	_bootstrap = null;
	_initialized = false;
	meter = undefined;
	metricsHandler = undefined;
}
