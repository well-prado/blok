/**
 * v0.6 Task 3b — workflow/process/trigger middleware merge on TriggerBase.
 *
 * Pre-v0.6 the 3-tier merge (process-global → workflow-level → trigger-level)
 * lived inline in `HttpTrigger.run`, so worker + cron triggers silently
 * skipped middleware. The merge now lives on `TriggerBase.applyMiddlewareChain`
 * and reads the trigger-level key off `getTriggerType()`, so HttpTrigger
 * reads `trigger.http.middleware`, WorkerTrigger reads
 * `trigger.worker.middleware`, CronTrigger reads `trigger.cron.middleware`.
 *
 * These tests exercise the merge directly by sub-classing TriggerBase and
 * overriding `runMiddlewareChain` with a spy — proving the merge produces
 * the expected name list for each trigger type, in the correct order, and
 * that empty merges short-circuit the dispatcher.
 */

import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TriggerBase from "../../src/TriggerBase";
import type GlobalOptions from "../../src/types/GlobalOptions";
import { WorkflowRegistry } from "../../src/workflow/WorkflowRegistry";

class TestTrigger extends TriggerBase {
	/** Captured arguments to `runMiddlewareChain` for assertion. */
	public captured: { names: readonly string[]; nodeMap: GlobalOptions } | null = null;
	/** Number of times the dispatcher was invoked (proves empty-merge short-circuit). */
	public dispatchCount = 0;

	constructor(private readonly triggerTypeTag: string) {
		super();
	}

	override async listen(): Promise<number> {
		return 0;
	}

	async stop(): Promise<void> {
		// no-op
	}

	protected override getTriggerType(): string {
		return this.triggerTypeTag;
	}

	protected override async runMiddlewareChain(
		_ctx: Context,
		names: readonly string[],
		nodeMap: GlobalOptions,
	): Promise<void> {
		this.dispatchCount++;
		this.captured = { names, nodeMap };
	}

	/** Expose the protected helper so tests don't need to reach through `this`. */
	async invoke(ctx: Context, nodeMap: GlobalOptions): Promise<void> {
		await this.applyMiddlewareChain(ctx, nodeMap);
	}

	/**
	 * Stamp `this.configuration` so the helper sees workflow-level
	 * `appliedMiddleware` and trigger-level `trigger.<type>.middleware`.
	 * Avoids the cost of running `Configuration.init` against a real
	 * workflow file — the helper only reads these two surfaces.
	 */
	setConfig(opts: {
		appliedMiddleware?: readonly string[];
		triggerMiddleware?: readonly string[];
	}): void {
		(this.configuration as unknown as { appliedMiddleware: readonly string[] }).appliedMiddleware =
			opts.appliedMiddleware ?? [];
		(this.configuration as unknown as { trigger: Record<string, { middleware?: readonly string[] }> }).trigger = {
			[this.triggerTypeTag]: opts.triggerMiddleware ? { middleware: opts.triggerMiddleware } : {},
		};
	}
}

const stubCtx = (): Context =>
	({
		id: "test",
		workflow_name: "test-wf",
		request: { headers: {}, body: {}, query: {}, params: {} },
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} },
		config: {},
		vars: {},
		env: {},
	}) as unknown as Context;

const stubNodeMap = (): GlobalOptions => ({}) as unknown as GlobalOptions;

describe("TriggerBase.applyMiddlewareChain — v0.6 Task 3b", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
	});

	describe("trigger-type-aware key lookup", () => {
		it("HttpTrigger reads trigger.http.middleware", async () => {
			const t = new TestTrigger("http");
			t.setConfig({ triggerMiddleware: ["http-only-mw"] });
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["http-only-mw"]);
		});

		it("WorkerTrigger reads trigger.worker.middleware", async () => {
			const t = new TestTrigger("worker");
			t.setConfig({ triggerMiddleware: ["worker-only-mw"] });
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["worker-only-mw"]);
		});

		it("CronTrigger reads trigger.cron.middleware", async () => {
			const t = new TestTrigger("cron");
			t.setConfig({ triggerMiddleware: ["cron-only-mw"] });
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["cron-only-mw"]);
		});
	});

	describe("3-tier merge order (outer → inner)", () => {
		it("global → workflow → trigger for HTTP", async () => {
			WorkflowRegistry.getInstance().setGlobalMiddleware(["global-a", "global-b"]);
			const t = new TestTrigger("http");
			t.setConfig({
				appliedMiddleware: ["wf-mw"],
				triggerMiddleware: ["trig-mw"],
			});
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["global-a", "global-b", "wf-mw", "trig-mw"]);
		});

		it("global → workflow → trigger for Worker", async () => {
			WorkflowRegistry.getInstance().setGlobalMiddleware(["request-id", "audit-log"]);
			const t = new TestTrigger("worker");
			t.setConfig({
				appliedMiddleware: ["auth"],
				triggerMiddleware: ["job-validate"],
			});
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["request-id", "audit-log", "auth", "job-validate"]);
		});

		it("global → workflow → trigger for Cron", async () => {
			WorkflowRegistry.getInstance().setGlobalMiddleware(["request-id"]);
			const t = new TestTrigger("cron");
			t.setConfig({
				appliedMiddleware: ["audit-log"],
				triggerMiddleware: ["lock-acquire"],
			});
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["request-id", "audit-log", "lock-acquire"]);
		});
	});

	describe("short-circuit when no middleware configured", () => {
		it("does not invoke the dispatcher when all three tiers are empty", async () => {
			const t = new TestTrigger("worker");
			t.setConfig({});
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.dispatchCount).toBe(0);
			expect(t.captured).toBeNull();
		});

		it("does not invoke the dispatcher when trigger has no middleware key", async () => {
			const t = new TestTrigger("cron");
			// Stamp configuration.trigger but without a middleware field.
			(t as unknown as { configuration: { trigger: unknown } }).configuration.trigger = { cron: {} };
			(t as unknown as { configuration: { appliedMiddleware: readonly string[] } }).configuration.appliedMiddleware =
				[];
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.dispatchCount).toBe(0);
		});
	});

	describe("tier independence", () => {
		it("global only (no workflow, no trigger)", async () => {
			WorkflowRegistry.getInstance().setGlobalMiddleware(["only-global"]);
			const t = new TestTrigger("worker");
			t.setConfig({});
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["only-global"]);
		});

		it("workflow only (no global, no trigger)", async () => {
			const t = new TestTrigger("worker");
			t.setConfig({ appliedMiddleware: ["only-wf"] });
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["only-wf"]);
		});

		it("trigger only (no global, no workflow)", async () => {
			const t = new TestTrigger("worker");
			t.setConfig({ triggerMiddleware: ["only-trig"] });
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["only-trig"]);
		});
	});

	describe("nodeMap propagation", () => {
		it("passes nodeMap through to the dispatcher", async () => {
			const t = new TestTrigger("worker");
			t.setConfig({ triggerMiddleware: ["mw"] });
			const nm = stubNodeMap();
			await t.invoke(stubCtx(), nm);
			expect(t.captured?.nodeMap).toBe(nm);
		});
	});

	describe("malformed trigger-level config is filtered to strings", () => {
		it("non-string entries in trigger.<type>.middleware are dropped", async () => {
			const t = new TestTrigger("worker");
			// Bypass setConfig so we can stamp a mixed-type array verbatim.
			(t as unknown as { configuration: { trigger: unknown; appliedMiddleware: readonly string[] } }).configuration = {
				...(t as unknown as { configuration: object }).configuration,
				trigger: {
					worker: { middleware: ["valid-mw", 42, null, "", "another-mw"] },
				},
				appliedMiddleware: [],
			} as unknown as TriggerBase["configuration"];
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.captured?.names).toEqual(["valid-mw", "another-mw"]);
		});

		it("trigger.<type>.middleware as a non-array is treated as empty", async () => {
			const t = new TestTrigger("worker");
			(t as unknown as { configuration: { trigger: unknown; appliedMiddleware: readonly string[] } }).configuration = {
				...(t as unknown as { configuration: object }).configuration,
				trigger: { worker: { middleware: "not-an-array" } },
				appliedMiddleware: [],
			} as unknown as TriggerBase["configuration"];
			await t.invoke(stubCtx(), stubNodeMap());
			expect(t.dispatchCount).toBe(0);
		});
	});
});
