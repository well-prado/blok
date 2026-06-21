/**
 * WorkerTrigger.handleJob — per-job middleware resolution (F2 regression)
 *
 * The F2 fix gave each job its OWN `Configuration` and stopped initializing
 * the shared `this.configuration`. `applyMiddlewareChain` historically read
 * trigger-level (`trigger.<type>.middleware`) and workflow-level
 * (`appliedMiddleware`) names off `this.configuration` — which the worker no
 * longer populates. Unless the per-job config is threaded into
 * `applyMiddlewareChain`, every worker job silently drops its trigger-level
 * and workflow-level middleware (only the process-global chain, sourced from
 * the registry, would survive).
 *
 * This exercises the inherited `applyMiddlewareChain(ctx, nodeMap, configuration)`
 * surface directly: it must read the merged chain from the PASSED config, not
 * the shared `this.configuration`. (We test at this level rather than driving a
 * full `handleJob` because trigger-level `middleware` is not a worker-schema
 * field today and the v2 `workflow()` helper drops the root `middleware` array,
 * so a real per-job config's middleware can only be exercised by stamping it —
 * which is exactly what the per-job `Configuration.init` does at runtime.)
 */

import { type BlokService, Configuration, type GlobalOptions, defineNode } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkerTrigger } from "./WorkerTrigger";

const echoNode = defineNode({
	name: "echo",
	description: "echoes",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	async execute(_ctx, input) {
		return input;
	},
});

class TestWorkerTrigger extends WorkerTrigger {
	protected nodes: Record<string, BlokService<unknown>> = { echo: echoNode as unknown as BlokService<unknown> };
	protected workflows: Record<string, never> = {};

	/** Captured names passed to the middleware dispatcher. */
	public capturedMiddleware: readonly string[] | null = null;

	constructor() {
		super();
		this.loadNodes();
	}

	// The real WorkerTrigger's getTriggerType() returns "worker"; our subclass
	// name would yield "testworker", so pin it for the trigger-level key lookup.
	protected override getTriggerType(): string {
		return "worker";
	}

	protected override async runMiddlewareChain(
		_ctx: Context,
		names: readonly string[],
		_nodeMap: GlobalOptions,
	): Promise<void> {
		this.capturedMiddleware = names;
	}

	/** Expose the protected helper for direct exercise. */
	public invoke(ctx: Context, nodeMap: GlobalOptions, configuration?: Configuration) {
		return this.applyMiddlewareChain(ctx, nodeMap, configuration);
	}
}

/** Stamp a Configuration with the two surfaces applyMiddlewareChain reads. */
function stampConfig(opts: { applied?: readonly string[]; triggerMw?: readonly string[] }): Configuration {
	const cfg = new Configuration();
	(cfg as unknown as { appliedMiddleware: readonly string[] }).appliedMiddleware = opts.applied ?? [];
	(cfg as unknown as { trigger: Record<string, { middleware?: readonly string[] }> }).trigger = {
		worker: opts.triggerMw ? { middleware: opts.triggerMw } : {},
	};
	return cfg;
}

const stubCtx = (): Context =>
	({
		id: "t",
		request: { headers: {}, body: {}, query: {}, params: {} },
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} },
		config: {},
		vars: {},
	}) as unknown as Context;

const stubNodeMap = (): GlobalOptions => ({}) as unknown as GlobalOptions;

describe("WorkerTrigger.applyMiddlewareChain — per-job config (F2)", () => {
	afterEach(() => {
		// no global state to reset (no registry middleware used here)
	});

	it("reads trigger-level + workflow-level middleware from the PASSED per-job config", async () => {
		const trigger = new TestWorkerTrigger();
		const perJob = stampConfig({ applied: ["auth"], triggerMw: ["job-validate"] });

		await trigger.invoke(stubCtx(), stubNodeMap(), perJob);

		// merge order: global (none) → workflow-level → trigger-level
		expect(trigger.capturedMiddleware).toEqual(["auth", "job-validate"]);
	});

	it("does NOT see middleware that lives only on the SHARED this.configuration", async () => {
		const trigger = new TestWorkerTrigger();
		// Poison the shared config — if the worker still read it, this would leak.
		(trigger as unknown as { configuration: Configuration }).configuration = stampConfig({
			applied: ["leaked-shared-mw"],
			triggerMw: ["leaked-shared-trigger"],
		});
		// Pass an EMPTY per-job config (the real worker resolves a fresh one).
		const perJob = stampConfig({});

		await trigger.invoke(stubCtx(), stubNodeMap(), perJob);

		// Empty merge short-circuits — the shared config's names must NOT leak.
		expect(trigger.capturedMiddleware).toBeNull();
	});

	it("still defaults to this.configuration when no per-job config is passed (back-compat)", async () => {
		const trigger = new TestWorkerTrigger();
		(trigger as unknown as { configuration: Configuration }).configuration = stampConfig({
			applied: ["shared-default"],
		});

		await trigger.invoke(stubCtx(), stubNodeMap());

		expect(trigger.capturedMiddleware).toEqual(["shared-default"]);
	});
});
