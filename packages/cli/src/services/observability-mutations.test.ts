import { describe, expect, it } from "vitest";
import {
	rewriteObservabilityEnvBlock,
	withObservabilityModule,
	withoutObservabilityModule,
} from "./observability-mutations.js";
import type { ProjectConfig } from "./runtime-setup.js";

const mod = (addedAt = "2026-01-01T00:00:00.000Z") => ({ enabled: true, addedAt });

describe("withObservabilityModule / withoutObservabilityModule", () => {
	it("adds a module while preserving runtimes + triggers", () => {
		const base: ProjectConfig = { runtimes: { go: { port: 0, startCmd: "", cwd: "", kind: "go", label: "Go" } } };
		const next = withObservabilityModule(base, "metrics", mod());
		expect(next.observability).toEqual({ metrics: mod() });
		expect(next.runtimes).toBe(base.runtimes); // untouched
	});

	it("re-adding the same module is a no-op (identical output)", () => {
		const a = withObservabilityModule({}, "tracing", mod());
		const b = withObservabilityModule(a, "tracing", mod());
		expect(b).toEqual(a);
	});

	it("removing the last module drops the observability key entirely", () => {
		const one = withObservabilityModule({}, "metrics", mod());
		const gone = withoutObservabilityModule(one, "metrics");
		expect(gone.observability).toBeUndefined();
	});

	it("removing an absent module is a no-op", () => {
		const cfg: ProjectConfig = { observability: { metrics: mod() } };
		expect(withoutObservabilityModule(cfg, "tracing")).toBe(cfg);
	});

	it("removing one of several keeps the rest", () => {
		const cfg = withObservabilityModule(withObservabilityModule({}, "metrics", mod()), "tracing", mod());
		const next = withoutObservabilityModule(cfg, "metrics");
		expect(Object.keys(next.observability ?? {})).toEqual(["tracing"]);
	});
});

describe("rewriteObservabilityEnvBlock", () => {
	it("appends a fenced block and is idempotent (run twice = identical)", () => {
		const blocks = ["BLOK_TRACE_STORE=sqlite", "# BLOK_METRICS_DISABLED=1"];
		const once = rewriteObservabilityEnvBlock("PORT=4000\n", blocks);
		const twice = rewriteObservabilityEnvBlock(once, blocks);
		expect(twice).toBe(once);
		expect(once).toContain("PORT=4000");
		expect(once).toContain("BLOK_TRACE_STORE=sqlite");
		expect(once.match(/managed by blokctl/g)?.length).toBe(2); // exactly one start + one end marker
	});

	it("preserves unrelated env vars when the module set changes", () => {
		const first = rewriteObservabilityEnvBlock("SECRET=abc\n", ["BLOK_TRACE_STORE=sqlite"]);
		const second = rewriteObservabilityEnvBlock(first, ["CONSOLE_LOG_ACTIVE=true"]);
		expect(second).toContain("SECRET=abc");
		expect(second).toContain("CONSOLE_LOG_ACTIVE=true");
		expect(second).not.toContain("BLOK_TRACE_STORE"); // old module's vars removed
	});

	it("removes the block when no modules remain", () => {
		const withBlock = rewriteObservabilityEnvBlock("SECRET=abc\n", ["BLOK_TRACE_STORE=sqlite"]);
		const cleared = rewriteObservabilityEnvBlock(withBlock, []);
		expect(cleared).toBe("SECRET=abc\n");
		expect(cleared).not.toContain("managed by blokctl");
	});

	it("rejects BLOK_METRICS_ENABLED (only the DISABLED kill-switch is supported)", () => {
		expect(() => rewriteObservabilityEnvBlock("", ["BLOK_METRICS_ENABLED=false"])).toThrow(/BLOK_METRICS_ENABLED/);
	});
});
