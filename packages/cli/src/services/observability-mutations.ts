/**
 * Pure, file-system-free helpers for enabling/disabling observability modules
 * in a project's `.blok/config.json` and `.env.local`. Side-effect-free so
 * they're trivially unit-testable; the `observability add` / `observability
 * remove` commands do the file I/O around them.
 *
 * Mirrors runtime-mutations.ts, but the env block is DELIMITED (start/end
 * markers) rather than line-pattern-matched: observability spans many env
 * prefixes (OTEL_*, BLOK_TRACE_*, BLOK_METRICS_*, CONSOLE_LOG_*, SENTRY_*) plus
 * inline comments, so a fenced block is the robust way to rewrite it idempotently.
 */

import type { ObservabilityModuleConfig, ProjectConfig } from "./runtime-setup.js";

const OBS_START = "# >>> Blok observability (managed by blokctl) >>>";
const OBS_END = "# <<< Blok observability (managed by blokctl) <<<";

/** Add or replace an observability module in the config map. Preserves runtimes/triggers/siblings. Pure. */
export function withObservabilityModule(
	config: ProjectConfig,
	id: string,
	moduleConfig: ObservabilityModuleConfig,
): ProjectConfig {
	return { ...config, observability: { ...(config.observability ?? {}), [id]: moduleConfig } };
}

/**
 * Remove a module by id. The `observability` key becomes `undefined` (dropped by
 * `JSON.stringify`) when this was the last one. Removing an absent module is a
 * no-op (returns the same config). Pure.
 */
export function withoutObservabilityModule(config: ProjectConfig, id: string): ProjectConfig {
	if (!config.observability || !(id in config.observability)) return config;
	const rest = Object.fromEntries(Object.entries(config.observability).filter(([k]) => k !== id));
	return { ...config, observability: Object.keys(rest).length === 0 ? undefined : rest };
}

/** Strip the fenced managed block (inclusive) from an `.env.local` string. */
function stripManagedBlock(envContent: string): string {
	const out: string[] = [];
	let inside = false;
	for (const line of envContent.split("\n")) {
		if (line.trim() === OBS_START) {
			inside = true;
			continue;
		}
		if (inside) {
			if (line.trim() === OBS_END) inside = false;
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

/**
 * Rewrite the blokctl-managed observability block inside a `.env.local` string
 * so it exactly reflects the given module env blocks. Strips any existing fenced
 * block, then re-appends a fresh one. Running twice with the same input yields
 * identical output (idempotent). Empty input removes the block entirely. Pure.
 *
 * Rejects `BLOK_METRICS_ENABLED` — metrics are ON by default; the only supported
 * switch is `BLOK_METRICS_DISABLED=1` (the BLOK_*_DISABLED kill-switch family).
 */
export function rewriteObservabilityEnvBlock(envContent: string, moduleBlocks: string[]): string {
	for (const block of moduleBlocks) {
		if (/\bBLOK_METRICS_ENABLED\b/.test(block)) {
			throw new Error(
				"BLOK_METRICS_ENABLED is not a supported flag — metrics are ON by default; disable with BLOK_METRICS_DISABLED=1.",
			);
		}
	}

	const cleaned = stripManagedBlock(envContent)
		.replace(/\n{3,}/g, "\n\n") // collapse blank-line drift where the block was
		.replace(/\n+$/, "");

	const body = moduleBlocks
		.map((b) => b.trim())
		.filter(Boolean)
		.join("\n\n");

	if (!body) return cleaned.length > 0 ? `${cleaned}\n` : "";

	const block = `${OBS_START}\n${body}\n${OBS_END}`;
	return cleaned.length > 0 ? `${cleaned}\n\n${block}\n` : `${block}\n`;
}
