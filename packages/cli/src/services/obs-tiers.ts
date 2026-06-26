/**
 * Observability dev-stack tiers for `blokctl create --obs-stack`.
 *
 * Historically `create` copied the ENTIRE `infra/metrics/` stack (Prometheus,
 * Grafana, Loki, Tempo, Alloy, Alertmanager, nginx) into every project. Tiers
 * let a project take none of it, a lightweight metrics-only slice, or the works.
 *
 * Service names MUST match the `services:` keys in
 * `infra/metrics/docker-compose.yml` exactly — the tiered copy trims the compose
 * file down to the tier's services by those keys.
 */

export type ObsStackTier = "none" | "lite" | "full";

export const OBS_STACK_TIERS: readonly ObsStackTier[] = ["none", "lite", "full"];

/** Every service defined in infra/metrics/docker-compose.yml. */
export const ALL_OBS_SERVICES = ["prometheus", "alertmanager", "grafana", "tempo", "loki", "nginx", "alloy"] as const;

export interface TierDefinition {
	/** docker-compose service keys to KEEP (others are trimmed out). */
	services: string[];
	/**
	 * Files/dirs under `infra/metrics/` to copy. `"*"` means copy everything
	 * (the `full` tier preserves the legacy behaviour verbatim).
	 */
	files: string[] | "*";
}

export const TIER_DEFINITIONS: Record<ObsStackTier, TierDefinition> = {
	none: { services: [], files: [] },
	// lite = metrics-only: Prometheus scrapes, Grafana renders. Loki/Tempo/Alloy
	// (logs + traces) and the alertmanager/nginx wrappers are left out. `rules/`
	// + `prometheus.yml` are kept so Prometheus boots cleanly; `datasources.yml`
	// is copied verbatim (Grafana tolerates its unreachable loki/tempo entries).
	lite: {
		services: ["prometheus", "grafana"],
		files: ["docker-compose.yml", "prometheus.yml", "rules", "datasources.yml", "dashboards", "dashboard.json"],
	},
	full: { services: [...ALL_OBS_SERVICES], files: "*" },
};

/** Validate a raw `--obs-stack` value, throwing a friendly error on a bad tier. */
export function parseObsTier(value: string): ObsStackTier {
	const v = value.trim().toLowerCase();
	if ((OBS_STACK_TIERS as readonly string[]).includes(v)) return v as ObsStackTier;
	throw new Error(`Invalid --obs-stack "${value}". Choose one of: ${OBS_STACK_TIERS.join(", ")}.`);
}
