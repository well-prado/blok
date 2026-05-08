/**
 * ForEachNode — v0.5 primitive. Iterates over a collection, running a
 * sub-pipeline of steps for each item. Supports sequential and parallel
 * (with bounded concurrency) modes.
 *
 * The runtime config is read from `ctx.config[this.name]`:
 *   {
 *     in: unknown[],          // resolved by the blueprint mapper before run()
 *     as: string,             // per-iteration variable name; lands at ctx.state[as]
 *     mode: "sequential" | "parallel",
 *     concurrency: number,    // parallel mode only
 *     steps: NodeBase[],      // pre-resolved by Configuration's isFlowWithProperties path
 *   }
 *
 * Per-iteration scoping: a child ctx is built per item with
 * `ctx.state[as] = item` and `ctx.state[as + "Index"] = i`. Mutations
 * to state inside an iteration do NOT bleed to other iterations
 * (parallel safety, plus matches the documented forEach contract).
 *
 * Errors in any iteration propagate to the caller. The runner's outer
 * step-level catch wraps them into the standard error envelope.
 */

import type { Context, ResponseContext } from "@blokjs/shared";
import _ from "lodash";
import RunnerNode from "./RunnerNode";
import { applyStepOutput } from "./workflow/PersistenceHelper";

interface ForEachOpts {
	in?: unknown;
	as?: string;
	mode?: "sequential" | "parallel";
	concurrency?: number;
	steps?: RunnerNode[];
}

export class ForEachNode extends RunnerNode {
	async run(ctx: Context): Promise<ResponseContext> {
		this.contentType = "application/json";
		const response: ResponseContext = { success: true, data: [], error: null };

		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as ForEachOpts;
		const items = Array.isArray(opts.in) ? (opts.in as unknown[]) : [];
		const as = typeof opts.as === "string" && opts.as.length > 0 ? opts.as : "item";
		const mode = opts.mode === "parallel" ? "parallel" : "sequential";
		const concurrency = typeof opts.concurrency === "number" && opts.concurrency > 0 ? opts.concurrency : 10;
		const steps = (opts.steps ?? []) as RunnerNode[];

		if (items.length === 0 || steps.length === 0) {
			response.data = [];
			applyStepOutput(ctx, this, { data: [] });
			return response;
		}

		// Lazy import to avoid circular dep (Runner pulls in Configuration).
		const { default: Runner } = await import("./Runner");

		const runIteration = async (item: unknown, index: number): Promise<unknown> => {
			const childCtx = this.cloneCtxForIteration(ctx, as, item, index);
			const runner = new Runner(steps);
			// `deep: true` — inner pipelines must not inherit the outer
			// run's `lastCompletedStepIndex` cursor (PR 4 wait/resume logic)
			// or every iteration's nested steps get marked "skipped (resumed
			// past wait...)" and the iteration produces no output.
			await runner.run(childCtx, { deep: true, stepName: this.name });
			// After Runner.runSteps, `childCtx.response` is set to the last
			// step's resolved data (RunnerSteps line ~349: `ctx.response =
			// model.data`). So `childCtx.response` IS the iteration's
			// output value, not a wrapped envelope.
			return childCtx.response;
		};

		const results: unknown[] = new Array(items.length);

		if (mode === "sequential") {
			for (let i = 0; i < items.length; i++) {
				results[i] = await runIteration(items[i], i);
			}
		} else {
			// Parallel with bounded concurrency — simple worker-pool pattern.
			let nextIndex = 0;
			const workers: Promise<void>[] = [];
			const workerCount = Math.min(concurrency, items.length);
			for (let w = 0; w < workerCount; w++) {
				workers.push(
					(async () => {
						while (true) {
							const i = nextIndex++;
							if (i >= items.length) return;
							results[i] = await runIteration(items[i], i);
						}
					})(),
				);
			}
			await Promise.all(workers);
		}

		response.data = results;
		// Persist to ctx.state[this.name] so downstream steps can read via
		// $.state[id]. Class-based RunnerNode subclasses must call
		// applyStepOutput explicitly (BlokService does it implicitly via
		// its `run()` method, but we own our own run() here).
		applyStepOutput(ctx, this, { data: results });
		return response;
	}

	private cloneCtxForIteration(ctx: Context, as: string, item: unknown, index: number): Context {
		const baseState = (ctx.state ?? {}) as Record<string, unknown>;
		const state: Record<string, unknown> = { ...baseState };
		state[as] = item;
		state[`${as}Index`] = index;
		// Deep-clone config so per-iteration blueprint mapper resolutions
		// don't bleed across iterations (same hazard the v0.4 Configuration
		// deep-clone fix addressed at the workflow level).
		const config = _.cloneDeep(ctx.config);
		return {
			...ctx,
			state,
			vars: state,
			config,
			response: { data: null, success: true, error: null, contentType: "application/json" },
		} as Context;
	}
}
