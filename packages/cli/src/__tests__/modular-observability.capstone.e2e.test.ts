import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { resolveObservabilitySelection } from "../commands/observability/apply.js";
import { setupObservabilityStack } from "../services/obs-setup.js";
import { rewriteObservabilityEnvBlock } from "../services/observability-mutations.js";
import { type ObservabilityModuleConfig, readProjectConfig, writeProjectConfig } from "../services/runtime-setup.js";

/**
 * Capstone (MO-STUDIO-DOCS T5) — scaffold a SUBSET of observability modules the
 * way `blokctl create` does (the create-time helpers) and assert the footprint
 * is exactly that subset: selected modules present, unselected leave NO trace,
 * dependencies auto-resolve, and obs-stack tiers copy only their services.
 */

function findRepoRoot(): string | null {
	let dir = import.meta.dirname;
	for (let i = 0; i < 8; i++) {
		if (fs.existsSync(path.join(dir, "infra", "metrics", "docker-compose.yml"))) return dir;
		const up = path.dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}
const REPO = findRepoRoot();

describe("capstone — modular observability footprint", () => {
	let tmp: string;
	let envLocal: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blok-capstone-"));
		envLocal = path.join(tmp, ".env.local");
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	function scaffold(modules: string[], tier: "none" | "lite" | "full"): { added: string[] } {
		const sel = resolveObservabilitySelection(
			modules.filter((m) => m !== "obs-stack"),
			{ addedAt: "2026-01-01T00:00:00.000Z", version: "0.6.0", projectDir: tmp },
		);
		const obsConfig: Record<string, ObservabilityModuleConfig> | undefined =
			Object.keys(sel.configMap).length > 0 ? sel.configMap : undefined;
		writeProjectConfig(tmp, [], [], obsConfig);
		fs.writeFileSync(envLocal, rewriteObservabilityEnvBlock("", sel.envBlocks));
		if (REPO) setupObservabilityStack(REPO, tmp, tier);
		return { added: sel.added };
	}

	it("a metrics+tracing subset enables ONLY those — unselected modules leave no footprint", () => {
		scaffold(["metrics", "tracing"], "none");
		expect(Object.keys(readProjectConfig(tmp)?.observability ?? {}).sort()).toEqual(["metrics", "tracing"]);

		const env = fs.readFileSync(envLocal, "utf8");
		expect(env).toContain("BLOK_METRICS_DISABLED"); // metrics block (commented opt-out)
		expect(env).toContain("OTEL_EXPORTER_OTLP_ENDPOINT"); // tracing block
		// Unselected modules contribute nothing:
		expect(env).not.toContain("CONSOLE_LOG_ACTIVE"); // logging
		expect(env).not.toContain("SENTRY_DSN"); // error-sink
		expect(env).not.toContain("BLOK_TRACE_STORE"); // trace-store
		expect(env).not.toContain("BLOK_ALERTING_ENABLED"); // alerting
	});

	it("selecting alerting auto-pulls its metrics dependency", () => {
		const { added } = scaffold(["alerting"], "none");
		expect(added).toEqual(["metrics"]);
		expect(Object.keys(readProjectConfig(tmp)?.observability ?? {}).sort()).toEqual(["alerting", "metrics"]);
	});

	it("BLOK_METRICS_DISABLED round-trips inert (commented) — metrics stay ON by default", () => {
		scaffold(["metrics"], "none");
		for (const line of fs.readFileSync(envLocal, "utf8").split("\n")) {
			if (/BLOK_METRICS_DISABLED=/.test(line)) expect(line.trim().startsWith("#")).toBe(true);
		}
	});

	it("obs-stack=none copies no infra/metrics", () => {
		scaffold(["metrics"], "none");
		expect(fs.existsSync(path.join(tmp, "infra", "metrics"))).toBe(false);
	});

	it.skipIf(!REPO)("obs-stack=lite copies exactly prometheus + grafana", () => {
		scaffold(["metrics"], "lite");
		const compose = parseYaml(fs.readFileSync(path.join(tmp, "infra", "metrics", "docker-compose.yml"), "utf8")) as {
			services?: Record<string, unknown>;
		};
		expect(Object.keys(compose.services ?? {}).sort()).toEqual(["grafana", "prometheus"]);
	});
});
