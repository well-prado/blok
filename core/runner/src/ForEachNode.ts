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

/**
 * v0.6 wait-inside-primitives Phase 2 — resume hint set on ctx by
 * `TriggerBase.run` after rehydrating the forEach NodeRun's
 * `iteration_context` column. ForEachNode reads it on entry and:
 *
 *   - Skips iterations [0..iteration-1] (their work is captured in
 *     `completedResults`, no idempotencyKey lookups required).
 *   - Resumes iteration `iteration` from the inner step at
 *     `innerStepIndex` (the step that was about to throw the wait
 *     when the previous pass deferred). The inner runner picks up
 *     this hint from `_blokInnerResumeIndex` on the child ctx.
 *   - Iterations [iteration+1..end] run from scratch.
 *
 * Phase 2 wires this for SEQUENTIAL mode only. Parallel forEach
 * resume lands in Phase 3 with cancellation semantics.
 */
interface IterationResume {
	iteration: number;
	innerStepIndex: number;
	completedResults: unknown[];
}

export class ForEachNode extends RunnerNode {
	/**
	 * v0.6 marker — RunnerSteps stamps `_blokActivePrimitiveNodeRunId`
	 * on ctx around `step.process()` calls when this flag is true so a
	 * nested wait fired inside an iteration body knows which NodeRun to
	 * write its `iteration_context` cursor to. Static `true` (vs an
	 * instance method) avoids importing ForEachNode inside RunnerSteps,
	 * which would create a circular dependency.
	 */
	public readonly isPrimitiveIterator = true;

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

		// v0.6 Phase 2 — read the resume hint that TriggerBase rehydrated
		// from the persisted `iteration_context` column. Cleared after
		// reading so a sibling forEach later in the workflow doesn't
		// accidentally pick it up.
		const ctxAny = ctx as Record<string, unknown>;
		const resume = ctxAny._blokIterationResume as IterationResume | undefined;
		if (resume !== undefined) {
			ctxAny._blokIterationResume = undefined;
		}

		// Lazy import to avoid circular dep (Runner pulls in Configuration).
		const { default: Runner } = await import("./Runner");

		// Pre-populate results[] with cached iteration outputs (Phase 2 —
		// resume case). On a fresh first pass `resume` is undefined and
		// results starts empty.
		const results: unknown[] = new Array(items.length);
		if (resume?.completedResults) {
			const cap = Math.min(resume.completedResults.length, items.length);
			for (let k = 0; k < cap; k++) {
				results[k] = resume.completedResults[k];
			}
		}

		const runIteration = async (item: unknown, index: number, innerResumeIndex?: number): Promise<unknown> => {
			const childCtx = this.cloneCtxForIteration(ctx, as, item, index);
			// v0.6 Phase 2 — pass the inner-step resume cursor on the
			// child ctx. The nested runner reads `_blokInnerResumeIndex`
			// to skip pre-wait inner steps that already completed in the
			// previous pass.
			if (innerResumeIndex !== undefined && innerResumeIndex > 0) {
				(childCtx as Record<string, unknown>)._blokInnerResumeIndex = innerResumeIndex;
			}
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

		if (mode === "sequential") {
			// v0.6 Phase 2 — start at the resume iteration if present,
			// else 0. Iterations before the resume index are not re-run;
			// their results were rehydrated above.
			const startIndex = resume?.iteration ?? 0;
			for (let i = startIndex; i < items.length; i++) {
				// v0.6 Phase 2 — stamp the iteration sentinels on the
				// PARENT ctx so RunnerSteps' nested wait throw can read
				// them via the child-ctx spread. Rewritten each iteration
				// so `completedResults` reflects results-so-far — when a
				// wait fires mid-iteration, the persisted context
				// contains exactly the iterations [0..i-1] that completed
				// before this one.
				ctxAny._blokForEachCurrentIteration = i;
				ctxAny._blokForEachPartialResults = results.slice(0, i);
				const innerResumeIndex = i === startIndex && resume !== undefined ? resume.innerStepIndex : undefined;
				results[i] = await runIteration(items[i], i, innerResumeIndex);
			}
			// Cleanup sentinels — sibling forEach later in the workflow
			// shouldn't see this one's pointers.
			ctxAny._blokForEachCurrentIteration = undefined;
			ctxAny._blokForEachPartialResults = undefined;
		} else {
			// Parallel with bounded concurrency — simple worker-pool pattern.
			// Phase 3 will add resume support; for now a parallel forEach
			// with a wait inside throws as before (no iteration_context
			// written, no resume hint consumed). Authors get the same
			// pre-v0.6 behaviour.
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
		const childCtx = {
			...ctx,
			state,
			vars: state,
			config,
			response: { data: null, success: true, error: null, contentType: "application/json" },
		} as Context;
		// v0.5.3 — stash the iteration index on the child ctx so RunnerSteps
		// can propagate it to NodeRun.iterationIndex when starting each
		// inner step. Studio reads this to group sibling rows by iteration
		// (5 iterations × 3 inner steps render as 5 collapsible sections,
		// not 15 flat rows with duplicate names). Overrides any sentinel
		// inherited from a parent iteration scope — the inner-most forEach
		// owns the index its inner steps see.
		(childCtx as Record<string, unknown>)._blokIterationIndex = index;
		return childCtx;
	}
}
