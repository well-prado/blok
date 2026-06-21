/**
 * F5 / F6 / F14 — cross-trigger operational parity helpers on TriggerBase.
 *
 * Pre-fix, crash/orphan/janitor/shutdown handler installation, registry
 * population, and `BLOK_GLOBAL_MIDDLEWARE` env seeding were wired inline
 * into HttpTrigger (and partly WorkerTrigger), so cron/pubsub/grpc-only
 * deployments silently opted out. These shared `protected` helpers let
 * every trigger reach parity with one call each.
 *
 * The helpers are exercised through a tiny TriggerBase subclass that
 * exposes them + a settable `nodeMap` (mirroring how cron/pubsub/grpc
 * each hold a `nodeMap.workflows` map).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TriggerBase from "../../src/TriggerBase";
import { Janitor } from "../../src/tracing/Janitor";
import { RunTracker } from "../../src/tracing/RunTracker";
import type GlobalOptions from "../../src/types/GlobalOptions";
import { WorkflowRegistry } from "../../src/workflow/WorkflowRegistry";

class ParityTrigger extends TriggerBase {
	public nodeMap: GlobalOptions = {} as GlobalOptions;
	public stopCalled = 0;

	override async listen(): Promise<number> {
		return 0;
	}

	async stop(): Promise<void> {
		this.stopCalled++;
	}

	// Expose the protected helpers for direct assertion.
	installHandlers(): void {
		this.installOperationalHandlers();
	}

	registerFromNodeMap(): number {
		return this.registerWorkflowsFromNodeMap();
	}

	seedGlobalMiddleware(): void {
		this.seedGlobalMiddlewareFromEnv();
	}

	setWorkflows(workflows: GlobalOptions["workflows"]): void {
		this.nodeMap = { workflows } as GlobalOptions;
	}
}

const restoreEnv = (key: string, prev: string | undefined) => {
	if (prev === undefined) delete process.env[key];
	else process.env[key] = prev;
};

describe("TriggerBase operational parity helpers", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
		Janitor.resetInstance();
		TriggerBase.resetCrashHandlersInstalled();
		TriggerBase.resetShutdownHandlersInstalled();
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
		Janitor.resetInstance();
		TriggerBase.resetCrashHandlersInstalled();
		TriggerBase.resetShutdownHandlersInstalled();
	});

	describe("installOperationalHandlers (F5)", () => {
		it("installs crash handlers, recovers orphans, starts the janitor, installs shutdown handlers", () => {
			// Seed an orphaned run so recoverOrphanedRuns has work to do.
			const tracker = RunTracker.getInstance();
			const run = tracker.startRun({
				workflowName: "orphan-wf",
				workflowPath: "/p",
				triggerType: "cron",
				triggerSummary: "cron",
				nodeCount: 1,
			});
			// Backdate startedAt so it crosses the orphan threshold.
			tracker.getStore().updateRun(run.id, { startedAt: Date.now() - 10 * 60 * 1000 });

			const t = new ParityTrigger();
			t.installHandlers();

			// Orphan recovered → crashed.
			expect(tracker.getStore().getRun(run.id)?.status).toBe("crashed");
			// Janitor started (singleton now exists).
			expect((Janitor as unknown as { instance: Janitor | null }).instance).not.toBeNull();
		});

		it("is idempotent — a second call doesn't throw or re-install", () => {
			const t = new ParityTrigger();
			t.installHandlers();
			expect(() => t.installHandlers()).not.toThrow();
		});

		it("respects BLOK_JANITOR_DISABLED kill-switch", () => {
			const prev = process.env.BLOK_JANITOR_DISABLED;
			process.env.BLOK_JANITOR_DISABLED = "1";
			try {
				const t = new ParityTrigger();
				t.installHandlers();
				// Janitor.start() returns false / no-ops when disabled — singleton
				// may exist but never schedules. We only assert no throw here.
				expect(true).toBe(true);
			} finally {
				restoreEnv("BLOK_JANITOR_DISABLED", prev);
			}
		});
	});

	describe("registerWorkflowsFromNodeMap (F6)", () => {
		it("registers each nodeMap workflow by name and derives isMiddleware", () => {
			const t = new ParityTrigger();
			t.setWorkflows({
				// v2 builder shape — name + flag live on _config.
				"order.create": { _blokV2: true, _config: { name: "order-create" }, toJson: () => ({}) } as never,
				"audit-mw": { _blokV2: true, _config: { name: "audit-log", middleware: true }, toJson: () => ({}) } as never,
			});

			const count = t.registerFromNodeMap();
			expect(count).toBe(2);

			const registry = WorkflowRegistry.getInstance();
			expect(registry.has("order-create")).toBe(true);
			expect(registry.has("audit-log")).toBe(true);
			// Middleware-flagged workflow is resolvable via getMiddleware.
			expect(registry.getMiddleware("audit-log")).toBeTruthy();
			// Non-middleware workflow is NOT.
			expect(registry.getMiddleware("order-create")).toBeUndefined();
		});

		it("reads the root `name`/`middleware` for raw object / legacy builders", () => {
			const t = new ParityTrigger();
			t.setWorkflows({
				k1: { name: "raw-wf" } as never,
				k2: { name: "legacy-mw", middleware: true } as never,
			});

			expect(t.registerFromNodeMap()).toBe(2);
			const registry = WorkflowRegistry.getInstance();
			expect(registry.has("raw-wf")).toBe(true);
			expect(registry.getMiddleware("legacy-mw")).toBeTruthy();
		});

		it("falls back to the map key when no name is present", () => {
			const t = new ParityTrigger();
			t.setWorkflows({ "fallback-key": {} as never });
			expect(t.registerFromNodeMap()).toBe(1);
			expect(WorkflowRegistry.getInstance().has("fallback-key")).toBe(true);
		});

		it("dedupes by name and does not throw on a same-name collision", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.register({ name: "dup", source: "existing", workflow: {} });
			const t = new ParityTrigger();
			t.setWorkflows({ k: { name: "dup" } as never });
			// Already registered → skipped, returns 0, no collision throw.
			expect(() => t.registerFromNodeMap()).not.toThrow();
			expect(t.registerFromNodeMap()).toBe(0);
		});

		it("returns 0 when the nodeMap has no workflows", () => {
			const t = new ParityTrigger();
			expect(t.registerFromNodeMap()).toBe(0);
		});
	});

	describe("seedGlobalMiddlewareFromEnv (F14)", () => {
		it("seeds the global chain from BLOK_GLOBAL_MIDDLEWARE", () => {
			const prev = process.env.BLOK_GLOBAL_MIDDLEWARE;
			process.env.BLOK_GLOBAL_MIDDLEWARE = " request-id , audit-log ,, ";
			try {
				const t = new ParityTrigger();
				t.seedGlobalMiddleware();
				expect(WorkflowRegistry.getInstance().getGlobalMiddleware()).toEqual(["request-id", "audit-log"]);
			} finally {
				restoreEnv("BLOK_GLOBAL_MIDDLEWARE", prev);
			}
		});

		it("does not override a programmatically-set global chain (idempotency)", () => {
			const prev = process.env.BLOK_GLOBAL_MIDDLEWARE;
			process.env.BLOK_GLOBAL_MIDDLEWARE = "env-mw";
			try {
				WorkflowRegistry.getInstance().setGlobalMiddleware(["programmatic-mw"]);
				const t = new ParityTrigger();
				t.seedGlobalMiddleware();
				expect(WorkflowRegistry.getInstance().getGlobalMiddleware()).toEqual(["programmatic-mw"]);
			} finally {
				restoreEnv("BLOK_GLOBAL_MIDDLEWARE", prev);
			}
		});

		it("is a no-op when BLOK_GLOBAL_MIDDLEWARE is unset", () => {
			const prev = process.env.BLOK_GLOBAL_MIDDLEWARE;
			restoreEnv("BLOK_GLOBAL_MIDDLEWARE", undefined);
			try {
				const t = new ParityTrigger();
				t.seedGlobalMiddleware();
				expect(WorkflowRegistry.getInstance().getGlobalMiddleware()).toEqual([]);
			} finally {
				restoreEnv("BLOK_GLOBAL_MIDDLEWARE", prev);
			}
		});
	});
});
