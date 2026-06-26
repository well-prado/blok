/**
 * The single source of truth for Blok's opt-in observability modules.
 *
 * Each module (metrics, tracing, trace-store, logging, alerting, error-sink,
 * obs-stack) is described by ONE `ObservabilityModuleDescriptor`. The CLI
 * foundation (this dir) owns the interface, the config schema, and the
 * add/remove/list/status command group; every per-module epic only fills in its
 * descriptor's values + optional hooks — none of them re-declare the interface.
 *
 * Foundation scope (MO-CLI): the descriptors below carry id/label/description/
 * dependencies + an inert-by-default `envBlock`. The heavy lifting
 * (`infraFiles`, `composeServices`, `scaffold`/`setup`/`verify`/`cleanup`) is
 * stubbed here and filled in by the module epics (MO-STACK, MO-TRACING, …).
 */

export type ObservabilityModuleId =
	| "obs-stack"
	| "tracing"
	| "trace-store"
	| "metrics"
	| "logging"
	| "alerting"
	| "error-sink";

export const OBSERVABILITY_MODULE_IDS: readonly ObservabilityModuleId[] = [
	"obs-stack",
	"tracing",
	"trace-store",
	"metrics",
	"logging",
	"alerting",
	"error-sink",
];

export interface ObservabilityScaffoldOpts {
	/** Absolute project root. */
	projectDir: string;
	/** True when running under `--yes` / non-TTY — hooks must not prompt. */
	nonInteractive: boolean;
}

export interface ObservabilityModuleDescriptor {
	/** Stable module id (also the `.blok/config.json` key + CLI argument). */
	id: ObservabilityModuleId;
	/** Short display name for prompts + summaries. */
	label: string;
	/** One-line description shown in pickers + `observability list`. */
	description: string;
	/** Module ids that must be enabled for this one to work (auto-resolved on add). */
	dependencies: ObservabilityModuleId[];
	/**
	 * Inert-by-default text appended to `.env.local` under the managed header.
	 * MUST be safe to commit and a no-op until the operator opts in — e.g. the
	 * metrics module emits a commented `# BLOK_METRICS_DISABLED=1` (metrics stay
	 * ON by default; opting OUT is the explicit, documented action). Pure.
	 */
	envBlock: (opts: { projectDir: string }) => string;
	/** Paths under `infra/` to copy into the project. Empty for env-only modules. (Filled by module epics.) */
	infraFiles: string[];
	/** docker-compose service names this module contributes. (Filled by module epics.) */
	composeServices: string[];
	/** package.json deps to merge. (Filled by module epics.) */
	packageDeps: Record<string, string>;
	/** Optional: copy/generate files into the project. Filled by the module epic. */
	scaffold?: (opts: ObservabilityScaffoldOpts) => Promise<{ filesCreated: string[] }>;
	/** Optional: idempotently write the module's env/config. Filled by the module epic. */
	setup?: (opts: ObservabilityScaffoldOpts) => Promise<void>;
	/** Optional: report whether the module is live (powers `observability status`). */
	verify?: (projectDir: string) => Promise<{ ok: boolean; message: string; dashboardUrl?: string }>;
	/** Optional: throw if the module's requirements aren't met (e.g. a peer dep). */
	validate?: (projectDir: string) => Promise<void>;
	/** Optional: reverse what `scaffold`/`setup` created (best-effort) on remove. */
	cleanup?: (opts: ObservabilityScaffoldOpts) => Promise<void>;
}

// NOTE on the env convention: metrics are ON by default and disabled via
// `BLOK_METRICS_DISABLED=1` (matching the BLOK_*_DISABLED kill-switch family
// already in core: BLOK_TRACING_DISABLED, BLOK_JANITOR_DISABLED, …). The
// inverse `BLOK_METRICS_ENABLED` is intentionally NOT used anywhere — the
// mutation helpers reject it (see observability-mutations.ts).

const REGISTRY: Record<ObservabilityModuleId, ObservabilityModuleDescriptor> = {
	"obs-stack": {
		id: "obs-stack",
		label: "Observability stack",
		description: "Local Prometheus/Grafana/Loki/Tempo dev stack (tiered: none|lite|full)",
		dependencies: [],
		envBlock: () => "",
		infraFiles: [],
		composeServices: [],
		packageDeps: {},
	},
	tracing: {
		id: "tracing",
		label: "Distributed tracing",
		description: "OTLP spans + W3C propagation → Tempo/Jaeger (already wired in all triggers)",
		dependencies: [],
		envBlock: () =>
			[
				"# Tracing (tracing module). Set the OTLP endpoint to enable; unset = no-op.",
				"OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318",
				"# BLOK_TRACING_DISABLED=1  # force-disable even when an endpoint is set",
			].join("\n"),
		infraFiles: [],
		composeServices: [],
		packageDeps: {},
	},
	"trace-store": {
		id: "trace-store",
		label: "Run trace store",
		description: "Durable run history + Studio API (sqlite | postgres | memory)",
		dependencies: [],
		envBlock: () =>
			[
				"# Trace store (trace-store module). sqlite is durable + the default outside tests.",
				"BLOK_TRACE_STORE=sqlite",
				"BLOK_TRACE_SQLITE_PATH=.blok/trace.db",
			].join("\n"),
		infraFiles: [],
		composeServices: [],
		packageDeps: {},
	},
	metrics: {
		id: "metrics",
		label: "Prometheus metrics",
		description: "~33 blok_* metrics + the /metrics exporter (ON by default)",
		dependencies: [],
		envBlock: () =>
			[
				"# Metrics (metrics module). The /metrics exporter is ON by default.",
				"# BLOK_METRICS_DISABLED=1  # uncomment to turn the exporter OFF",
				"# BLOK_METRICS_PORT=9464   # override the default exporter port",
			].join("\n"),
		infraFiles: [],
		composeServices: [],
		packageDeps: {},
	},
	logging: {
		id: "logging",
		label: "Structured logging → Loki",
		description: "JSON logs (run_id/trace_id) shipped to Loki via Grafana Alloy",
		dependencies: ["trace-store"],
		envBlock: () =>
			[
				"# Logging (logging module). Structured JSON to stdout; ship to Loki via Alloy.",
				"CONSOLE_LOG_ACTIVE=true",
				"# BLOK_LOG_LEVEL=info",
			].join("\n"),
		infraFiles: [],
		composeServices: [],
		packageDeps: {},
	},
	alerting: {
		id: "alerting",
		label: "Alerting rules",
		description: "Prometheus alert rules + Helm PrometheusRule",
		dependencies: ["metrics"],
		envBlock: () => "",
		infraFiles: [],
		composeServices: [],
		packageDeps: {},
	},
	"error-sink": {
		id: "error-sink",
		label: "Error sink (Sentry)",
		description: "Forward run failures to a Sentry-compatible error sink (set SENTRY_DSN)",
		dependencies: [],
		envBlock: () =>
			["# Error sink (error-sink module). Set a DSN to enable; unset = no-op.", "# SENTRY_DSN="].join("\n"),
		infraFiles: [],
		composeServices: [],
		packageDeps: {},
	},
};

/** Look up a module descriptor by id. Returns undefined for an unknown id. */
export function getObservabilityModule(id: string): ObservabilityModuleDescriptor | undefined {
	return REGISTRY[id as ObservabilityModuleId];
}

/** All module descriptors, in display order. */
export function allObservabilityModules(): ObservabilityModuleDescriptor[] {
	return OBSERVABILITY_MODULE_IDS.map((id) => REGISTRY[id]);
}

/**
 * Resolve a set of requested module ids to the full set including dependencies
 * (transitive), preserving a stable order. Pure. Throws on an unknown id.
 */
export function resolveWithDependencies(ids: string[]): {
	resolved: ObservabilityModuleId[];
	added: ObservabilityModuleId[];
} {
	const out = new Set<ObservabilityModuleId>();
	const visit = (id: string): void => {
		const mod = getObservabilityModule(id);
		if (!mod) throw new Error(`Unknown observability module "${id}". Known: ${OBSERVABILITY_MODULE_IDS.join(", ")}.`);
		if (out.has(mod.id)) return;
		for (const dep of mod.dependencies) visit(dep);
		out.add(mod.id);
	};
	for (const id of ids) visit(id);
	const resolved = OBSERVABILITY_MODULE_IDS.filter((id) => out.has(id));
	const requested = new Set(ids);
	const added = resolved.filter((id) => !requested.has(id));
	return { resolved, added };
}
