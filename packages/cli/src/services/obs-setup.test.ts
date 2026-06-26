import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { setupObservabilityStack } from "./obs-setup.js";
import { ALL_OBS_SERVICES } from "./obs-tiers.js";

/** Walk up from here until we find the monorepo root (has infra/metrics/docker-compose.yml). */
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
const composeServices = (dir: string): string[] => {
	const doc = parse(fs.readFileSync(path.join(dir, "infra", "metrics", "docker-compose.yml"), "utf8")) as {
		services?: Record<string, unknown>;
	};
	return Object.keys(doc.services ?? {});
};

// Skip gracefully if run outside the monorepo (e.g. a published-package context).
describe.skipIf(!REPO)("setupObservabilityStack — tiers (MO-STACK)", () => {
	const repo = REPO as string;
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blok-obs-tier-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("none: writes nothing — no infra/metrics dir", () => {
		const res = setupObservabilityStack(repo, tmp, "none");
		expect(res.copied).toEqual([]);
		expect(fs.existsSync(path.join(tmp, "infra", "metrics"))).toBe(false);
	});

	it("lite: exactly prometheus + grafana, and no loki/tempo/alloy", () => {
		setupObservabilityStack(repo, tmp, "lite");
		expect(composeServices(tmp).sort()).toEqual(["grafana", "prometheus"]);
		const m = path.join(tmp, "infra", "metrics");
		expect(fs.existsSync(path.join(m, "prometheus.yml"))).toBe(true);
		expect(fs.existsSync(path.join(m, "loki-config.yaml"))).toBe(false);
		expect(fs.existsSync(path.join(m, "tempo.yaml"))).toBe(false);
	});

	it("lite: no kept service depends_on a trimmed-away service", () => {
		setupObservabilityStack(repo, tmp, "lite");
		const doc = parse(fs.readFileSync(path.join(tmp, "infra", "metrics", "docker-compose.yml"), "utf8")) as {
			services?: Record<string, { depends_on?: string[] | Record<string, unknown> }>;
		};
		for (const svc of Object.values(doc.services ?? {})) {
			const dep = svc.depends_on;
			const deps = Array.isArray(dep) ? dep : dep ? Object.keys(dep) : [];
			for (const d of deps) expect(["prometheus", "grafana"]).toContain(d);
		}
	});

	it("full: all services + the whole file set", () => {
		setupObservabilityStack(repo, tmp, "full");
		expect(composeServices(tmp).sort()).toEqual([...ALL_OBS_SERVICES].sort());
		const m = path.join(tmp, "infra", "metrics");
		expect(fs.existsSync(path.join(m, "loki-config.yaml"))).toBe(true);
		expect(fs.existsSync(path.join(m, "tempo.yaml"))).toBe(true);
	});

	it("is idempotent — re-running lite yields an identical compose file", () => {
		setupObservabilityStack(repo, tmp, "lite");
		const composePath = path.join(tmp, "infra", "metrics", "docker-compose.yml");
		const first = fs.readFileSync(composePath, "utf8");
		setupObservabilityStack(repo, tmp, "lite");
		expect(fs.readFileSync(composePath, "utf8")).toBe(first);
	});
});
