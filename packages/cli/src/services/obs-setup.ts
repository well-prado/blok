/**
 * Tier-aware copy of the observability dev stack into a project. Replaces the
 * old unconditional `copySync(infra/metrics)` in `create`. Idempotent — safe to
 * re-run (used by both create-time scaffolding and the retrofit path).
 */

import path from "node:path";
import fsExtra from "fs-extra";
import { parse, stringify } from "yaml";
import { type ObsStackTier, TIER_DEFINITIONS } from "./obs-tiers.js";

interface ComposeDoc {
	services?: Record<string, { depends_on?: string[] | Record<string, unknown> }>;
}

/**
 * Copy `infra/metrics/` from `repoSource` into `projectDir/infra/metrics` for
 * the given tier, then trim the copied `docker-compose.yml` down to the tier's
 * services (and drop any `depends_on` pointing at trimmed-away services). The
 * `none` tier writes nothing. Returns the copied top-level entries.
 */
export function setupObservabilityStack(
	repoSource: string,
	projectDir: string,
	tier: ObsStackTier,
): { copied: string[] } {
	const def = TIER_DEFINITIONS[tier];
	if (tier === "none") return { copied: [] };

	const src = path.join(repoSource, "infra", "metrics");
	const dest = path.join(projectDir, "infra", "metrics");
	fsExtra.ensureDirSync(dest);

	const copied: string[] = [];
	if (def.files === "*") {
		fsExtra.copySync(src, dest);
		copied.push(...fsExtra.readdirSync(dest));
	} else {
		for (const entry of def.files) {
			const from = path.join(src, entry);
			if (fsExtra.existsSync(from)) {
				fsExtra.copySync(from, path.join(dest, entry));
				copied.push(entry);
			}
		}
	}

	trimComposeServices(path.join(dest, "docker-compose.yml"), def.services);
	return { copied };
}

/**
 * Rewrite a docker-compose file so it contains only `keep` services, parsing as
 * YAML (never string/regex). Also prunes each kept service's `depends_on` of any
 * trimmed-away service so the result stays a valid compose file. No-op when the
 * file is missing or `keep` covers every service. Idempotent.
 */
export function trimComposeServices(composePath: string, keep: string[]): void {
	if (!fsExtra.existsSync(composePath)) return;
	const doc = parse(fsExtra.readFileSync(composePath, "utf8")) as ComposeDoc;
	if (!doc.services) return;

	const keepSet = new Set(keep);
	let changed = false;
	for (const name of Object.keys(doc.services)) {
		if (!keepSet.has(name)) {
			delete doc.services[name];
			changed = true;
		}
	}
	// Prune dangling depends_on (compose supports both the list + map forms).
	for (const svc of Object.values(doc.services)) {
		const dep = svc.depends_on;
		if (Array.isArray(dep)) {
			const next = dep.filter((d) => keepSet.has(d));
			if (next.length !== dep.length) {
				changed = true;
				if (next.length > 0) svc.depends_on = next;
				else svc.depends_on = undefined;
			}
		} else if (dep && typeof dep === "object") {
			for (const d of Object.keys(dep)) {
				if (!keepSet.has(d)) {
					delete (dep as Record<string, unknown>)[d];
					changed = true;
				}
			}
			if (Object.keys(dep).length === 0) svc.depends_on = undefined;
		}
	}

	if (changed) fsExtra.writeFileSync(composePath, stringify(doc));
}
