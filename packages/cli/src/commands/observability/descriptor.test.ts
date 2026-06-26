import { describe, expect, it } from "vitest";
import { resolveObservabilitySelection } from "./apply.js";
import { allObservabilityModules, resolveWithDependencies } from "./descriptor.js";

describe("resolveWithDependencies", () => {
	it("pulls in a transitive dependency (alerting → metrics)", () => {
		const { resolved, added } = resolveWithDependencies(["alerting"]);
		expect(resolved).toContain("metrics");
		expect(resolved).toContain("alerting");
		expect(added).toEqual(["metrics"]);
	});

	it("logging → trace-store", () => {
		expect(resolveWithDependencies(["logging"]).resolved).toContain("trace-store");
	});

	it("no spurious deps for a leaf module, and no duplicates", () => {
		const { resolved, added } = resolveWithDependencies(["tracing", "tracing"]);
		expect(resolved).toEqual(["tracing"]);
		expect(added).toEqual([]);
	});

	it("throws on an unknown module id", () => {
		expect(() => resolveWithDependencies(["nope"])).toThrow(/Unknown observability module/);
	});

	it("every dependency id is itself a real module", () => {
		const ids = new Set(allObservabilityModules().map((m) => m.id));
		for (const m of allObservabilityModules()) for (const dep of m.dependencies) expect(ids.has(dep)).toBe(true);
	});
});

describe("resolveObservabilitySelection (create-time)", () => {
	const opts = { addedAt: "2026-01-01T00:00:00.000Z", version: "0.6.0", projectDir: "/tmp/x" };

	it("empty selection → empty everything", () => {
		expect(resolveObservabilitySelection([], opts)).toEqual({ configMap: {}, envBlocks: [], added: [] });
	});

	it("builds a config map for the resolved set incl. deps", () => {
		const { configMap, added } = resolveObservabilitySelection(["alerting"], opts);
		expect(Object.keys(configMap).sort()).toEqual(["alerting", "metrics"]);
		expect(configMap.metrics).toEqual({ enabled: true, addedAt: opts.addedAt, version: opts.version });
		expect(added).toEqual(["metrics"]);
	});
});
