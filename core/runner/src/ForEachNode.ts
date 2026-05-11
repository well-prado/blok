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
 *
 * v0.6 wait-inside-primitives:
 *   - Phase 2 — sequential + wait shipped via the cursor stamps below.
 *   - Phase 3 — parallel + wait shipped via the pool AbortController +
 *     Promise.allSettled classification + cursor write. See
 *     `docs/c/devtools/parallel-foreach-wait-spec.mdx` for the full
 *     design.
 */

import type { Context, ResponseContext } from "@blokjs/shared";
import _ from "lodash";
import { RunCancelledError } from "./RunCancelledError";
import RunnerNode from "./RunnerNode";
import { WaitDispatchRequest } from "./WaitDispatchRequest";
import { ForEachWaitMetrics } from "./monitoring/ForEachWaitMetrics";
import { RunTracker } from "./tracing/RunTracker";
import type { IterationContext, ParallelIterationContext, SequentialIterationContext } from "./tracing/types";
import { applyStepOutput } from "./workflow/PersistenceHelper";

interface ForEachOpts {
	in?: unknown;
	as?: string;
	mode?: "sequential" | "parallel";
	concurrency?: number;
	steps?: RunnerNode[];
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

		// v0.6 — read the resume hint that TriggerBase rehydrated from
		// the persisted `iteration_context` column. Cleared after reading
		// so a sibling forEach later in the workflow doesn't accidentally
		// pick it up.
		const ctxAny = ctx as Record<string, unknown>;
		const resume = ctxAny._blokIterationResume as IterationContext | undefined;
		if (resume !== undefined) {
			ctxAny._blokIterationResume = undefined;
		}

		// Lazy import to avoid circular dep (Runner pulls in Configuration).
		const { default: Runner } = await import("./Runner");

		// Discriminate on cursor mode at the read side. Sequential cursors
		// written before this PR omit the `mode` field — treated as
		// "sequential" by default. Parallel cursors are written ONLY by
		// the parallel branch below.
		const sequentialResume: SequentialIterationContext | undefined =
			resume && (resume.mode ?? "sequential") === "sequential" ? (resume as SequentialIterationContext) : undefined;
		const parallelResume: ParallelIterationContext | undefined =
			resume?.mode === "parallel" ? (resume as ParallelIterationContext) : undefined;

		// Pre-populate results[] from cursor — both sequential and parallel
		// resume paths use this. Sequential: contiguous slice [0..N-1].
		// Parallel: sparse — only slots present in `completedResults` get
		// filled; the rest stay `undefined` and get re-launched.
		const results: unknown[] = new Array(items.length);
		if (sequentialResume?.completedResults) {
			const cap = Math.min(sequentialResume.completedResults.length, items.length);
			for (let k = 0; k < cap; k++) {
				results[k] = sequentialResume.completedResults[k];
			}
		}
		if (parallelResume?.completedResults) {
			const cap = Math.min(parallelResume.completedResults.length, items.length);
			for (let k = 0; k < cap; k++) {
				const slot = parallelResume.completedResults[k];
				// `null` distinguishes "ran but returned undefined" (re-use
				// this value, don't re-launch) from a JSON-undefined hole
				// (not present — re-launch). Both deserialise to `null` in
				// some JSON encoders; we normalise sparse holes via
				// `Object.prototype.hasOwnProperty` against the parsed
				// array.
				if (Object.prototype.hasOwnProperty.call(parallelResume.completedResults, k) && slot !== undefined) {
					// null sentinel survives — readers see `results[k] === null`
					// meaning "ran, returned undefined" and skip re-launch.
					results[k] = slot;
				}
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
			const startIndex = sequentialResume?.iteration ?? 0;
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
				const innerResumeIndex =
					i === startIndex && sequentialResume !== undefined ? sequentialResume.innerStepIndex : undefined;
				results[i] = await runIteration(items[i], i, innerResumeIndex);
			}
			// Cleanup sentinels — sibling forEach later in the workflow
			// shouldn't see this one's pointers.
			ctxAny._blokForEachCurrentIteration = undefined;
			ctxAny._blokForEachPartialResults = undefined;
		} else {
			// === v0.6 Phase 3 — parallel forEach + wait =====================
			// See `docs/c/devtools/parallel-foreach-wait-spec.mdx`. Headline
			// contract: when one iteration's inner step throws
			// `WaitDispatchRequest`, peer in-flight iterations are
			// cancelled via a pool AbortController. Completed iterations'
			// results are persisted in the cursor's `completedResults`
			// sparse array; cancelled + queued iterations go in
			// `cancelledIterations` for re-launch on resume.
			//
			// The pool AbortController is distinct from `ctx.signal` —
			// tripping it MUST NOT cascade to the parent run (the parent
			// is waiting, not cancelled). Each iteration's child ctx gets
			// a per-iteration signal chained off BOTH the parent's signal
			// (so user-cancel still cascades) AND the pool signal (so
			// peer-wait cascades).
			const poolController = new AbortController();
			const poolSignal = poolController.signal;

			// On resume in parallel mode, the work queue is the set of
			// iterations that need to run: the wait-firing iter (with
			// inner resume hint) + all cancelled/queued iters (from
			// scratch). On a fresh pass, every iteration runs.
			const queue: number[] = [];
			if (parallelResume) {
				const toRun = new Set<number>();
				toRun.add(parallelResume.waitFiringIteration);
				for (const idx of parallelResume.cancelledIterations) {
					if (idx < items.length) toRun.add(idx);
				}
				// Any iterations beyond `completedResults.length` are
				// trailing-not-started — also need to run.
				for (let i = parallelResume.completedResults.length; i < items.length; i++) {
					if (results[i] === undefined) toRun.add(i);
				}
				queue.push(...Array.from(toRun).sort((a, b) => a - b));
			} else {
				for (let i = 0; i < items.length; i++) queue.push(i);
			}

			// Bookkeeping populated as workers settle. Wait-firing index
			// (lowest index wins on race), the original wait throw object
			// (for re-throw past Promise.allSettled), and the set of
			// indices cancelled by the pool. Errors short-circuit
			// classification — first non-wait error wins.
			type WorkerOutcome =
				| { kind: "completed"; index: number; result: unknown }
				| { kind: "wait"; index: number; throwObj: WaitDispatchRequest }
				| { kind: "cancelled"; index: number }
				| { kind: "error"; index: number; err: unknown };

			let queuePos = 0;
			const workerCount = Math.min(concurrency, queue.length);

			const launchWorker = async (): Promise<WorkerOutcome[]> => {
				const outcomes: WorkerOutcome[] = [];
				while (true) {
					const myQueuePos = queuePos++;
					if (myQueuePos >= queue.length) return outcomes;
					const index = queue[myQueuePos];
					// Skip if pool tripped before this iteration started —
					// classify as cancelled without doing any work.
					if (poolSignal.aborted) {
						outcomes.push({ kind: "cancelled", index });
						continue;
					}
					const innerResumeIndex =
						parallelResume !== undefined && index === parallelResume.waitFiringIteration
							? parallelResume.innerStepIndex
							: undefined;
					try {
						const result = await runIterationWithPool(item(items, index), index, innerResumeIndex, poolSignal);
						outcomes.push({ kind: "completed", index, result });
					} catch (err) {
						if (err instanceof WaitDispatchRequest) {
							// This iteration fired a wait. Trip the pool so
							// peers stop accepting new iterations and exit
							// their current ones at the next step boundary.
							if (!poolSignal.aborted) poolController.abort();
							outcomes.push({ kind: "wait", index, throwObj: err });
						} else if (err instanceof RunCancelledError) {
							// Distinguish pool-cancel from user-cancel. If
							// poolSignal is aborted AND ctx.signal is NOT,
							// this is a pool-induced cancellation due to a
							// peer's wait — re-runnable. Otherwise it's a
							// user-cancel — re-throw upstream.
							const userCancel = ctx.signal?.aborted === true && !poolSignal.aborted;
							if (userCancel) {
								outcomes.push({ kind: "error", index, err });
							} else {
								outcomes.push({ kind: "cancelled", index });
							}
						} else {
							// Real error. Trip the pool so peers stop
							// (don't waste CPU on a doomed forEach), then
							// record. Classification later: real errors
							// beat waits.
							if (!poolSignal.aborted) poolController.abort();
							outcomes.push({ kind: "error", index, err });
						}
					}
				}
			};

			// Helper — same as `runIteration` but threads the pool signal
			// through to the per-iteration child ctx (so RunnerSteps'
			// between-step abort check sees pool aborts).
			const runIterationWithPool = async (
				item_: unknown,
				index: number,
				innerResumeIndex: number | undefined,
				poolSig: AbortSignal,
			): Promise<unknown> => {
				const childCtx = this.cloneCtxForIteration(ctx, as, item_, index);
				const iterCtl = new AbortController();
				const listenerCleanup = new AbortController();
				// Chain from parent ctx.signal (user cancel cascade)
				if (ctx.signal) {
					if (ctx.signal.aborted) iterCtl.abort();
					else
						ctx.signal.addEventListener(
							"abort",
							() => {
								if (!iterCtl.signal.aborted) iterCtl.abort();
							},
							{ once: true, signal: listenerCleanup.signal },
						);
				}
				// Chain from pool signal (peer wait cascade)
				if (poolSig.aborted) iterCtl.abort();
				else
					poolSig.addEventListener(
						"abort",
						() => {
							if (!iterCtl.signal.aborted) iterCtl.abort();
						},
						{ once: true, signal: listenerCleanup.signal },
					);
				// Replace the inherited signal (which would be parent's)
				// with the per-iteration signal that cascades both ways.
				(childCtx as { signal: AbortSignal }).signal = iterCtl.signal;
				if (innerResumeIndex !== undefined && innerResumeIndex > 0) {
					(childCtx as Record<string, unknown>)._blokInnerResumeIndex = innerResumeIndex;
				}
				try {
					const runner = new Runner(steps);
					await runner.run(childCtx, { deep: true, stepName: this.name });
					return childCtx.response;
				} finally {
					// Detach the per-iteration listeners from parent +
					// pool signals (PR 1 A3 pattern — prevents listener
					// accumulation on long-lived parents over many
					// parallel forEach invocations).
					listenerCleanup.abort();
				}
			};

			// Spawn workers. Each returns its set of outcomes (one
			// outcome per iteration the worker handled). `allSettled`
			// gives us each worker's final state; we then flatten.
			const workers: Promise<WorkerOutcome[]>[] = [];
			for (let w = 0; w < workerCount; w++) {
				workers.push(launchWorker());
			}
			const settled = await Promise.allSettled(workers);

			// Flatten. A worker can't reject (its try/catch handles all
			// errors and classifies into the outcome list). But guard
			// defensively — rejection means a bug in launchWorker.
			const allOutcomes: WorkerOutcome[] = [];
			for (const s of settled) {
				if (s.status === "fulfilled") {
					allOutcomes.push(...s.value);
				} else {
					// Defensive — re-throw so the failure isn't lost.
					throw s.reason;
				}
			}

			// Classification step. Walk outcomes:
			//   1. If ANY non-wait error, re-throw the first one (errors
			//      beat waits per the spec).
			//   2. If ANY wait, identify the lowest-index wait as the
			//      wait-firing iteration; reclassify others as cancelled.
			//   3. Else, all iterations completed — fall through to
			//      normal completion below.
			const errors = allOutcomes.filter((o): o is { kind: "error"; index: number; err: unknown } => o.kind === "error");
			if (errors.length > 0) {
				// First error wins (sorted by iteration index for
				// determinism, even though only one re-throws).
				errors.sort((a, b) => a.index - b.index);
				throw errors[0].err;
			}

			const waits = allOutcomes.filter(
				(o): o is { kind: "wait"; index: number; throwObj: WaitDispatchRequest } => o.kind === "wait",
			);
			if (waits.length > 0) {
				// First-wait-wins by iteration index.
				waits.sort((a, b) => a.index - b.index);
				const waitFiring = waits[0];
				// Demote other waits to cancelled (they were racing — only
				// one resumes; the others re-run from scratch).
				const cancelledFromOtherWaits = waits.slice(1).map((w) => w.index);

				const completed = allOutcomes.filter(
					(o): o is { kind: "completed"; index: number; result: unknown } => o.kind === "completed",
				);
				const cancelled = allOutcomes
					.filter((o): o is { kind: "cancelled"; index: number } => o.kind === "cancelled")
					.map((o) => o.index);

				// Build the sparse completedResults array. Slot k =
				// completed iteration k's return value; null = "ran but
				// returned undefined"; JSON-undefined hole = "not
				// present" (cancelled / queued / wait-firing). On resume,
				// only present-non-undefined slots short-circuit
				// re-launch.
				const completedResults: (unknown | null)[] = new Array(items.length);
				for (const c of completed) {
					completedResults[c.index] = c.result === undefined ? null : c.result;
				}
				// Also stash the rehydrated completed iterations from the
				// resume cursor — if we're already on a re-entry pass,
				// those iterations don't appear in `completed` (they
				// were never launched this pass) but their results are
				// in `results[]` from the pre-populate above.
				if (parallelResume) {
					for (let k = 0; k < parallelResume.completedResults.length; k++) {
						if (
							Object.prototype.hasOwnProperty.call(parallelResume.completedResults, k) &&
							parallelResume.completedResults[k] !== undefined &&
							completedResults[k] === undefined
						) {
							completedResults[k] = parallelResume.completedResults[k];
						}
					}
				}

				const allCancelled = [...new Set([...cancelled, ...cancelledFromOtherWaits])].sort((a, b) => a - b);

				const cursor: ParallelIterationContext = {
					mode: "parallel",
					waitFiringIteration: waitFiring.index,
					// `throwObj.info.stepIndex` carries the inner step index
					// the wait fired at — exactly what we need.
					innerStepIndex: waitFiring.throwObj.info.stepIndex,
					completedResults,
					cancelledIterations: allCancelled,
				};

				// Write the cursor BEFORE re-throwing so TriggerBase's
				// rehydrate (on the next resume) sees the parallel-mode
				// shape. RunnerSteps may have written a sequential-shape
				// cursor at the wait-throw moment (Phase 2 path); this
				// write overwrites it on the same NodeRun id.
				this.writeCursor(ctx, cursor);

				// OTel — record the cancelled count so dashboards can
				// spot workflows that frequently waste work on cancel +
				// re-launch.
				try {
					ForEachWaitMetrics.getInstance().recordCancellation({
						workflowName: (ctx as { workflow_name?: string }).workflow_name ?? "unknown",
						cancelledCount: allCancelled.length,
					});
				} catch {
					// Metrics never block.
				}

				// Re-throw the original wait — TriggerBase catches it,
				// schedules the deferred dispatch, returns 202 to HTTP.
				throw waitFiring.throwObj;
			}

			// No waits, no errors — every iteration completed. Populate
			// `results[]` from the completed outcomes.
			for (const o of allOutcomes) {
				if (o.kind === "completed") {
					results[o.index] = o.result;
				}
			}
		}

		response.data = results;
		// Persist to ctx.state[this.name] so downstream steps can read via
		// $.state[id]. Class-based RunnerNode subclasses must call
		// applyStepOutput explicitly (BlokService does it implicitly via
		// its `run()` method, but we own our own run() here).
		applyStepOutput(ctx, this, { data: results });
		return response;
	}

	/**
	 * Write the cursor to the active forEach NodeRun. Stamped here (vs.
	 * via RunnerSteps' wait-throw site) because the parallel cursor is
	 * built post-`Promise.allSettled` — the wait-throw site doesn't know
	 * which peer iterations got cancelled OR which completed.
	 */
	private writeCursor(ctx: Context, cursor: ParallelIterationContext): void {
		const ctxAny = ctx as Record<string, unknown>;
		const primitiveNodeRunId = ctxAny._blokActivePrimitiveNodeRunId as string | undefined;
		if (!primitiveNodeRunId) return;
		try {
			RunTracker.getInstance().getStore().updateNodeRun(primitiveNodeRunId, {
				iterationContext: cursor,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.logger.logLevel(
				"warn",
				`[blok][wait] forEach parallel cursor write failed: ${msg}. Resume will re-run every iteration from scratch.`,
			);
		}
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

// Local helper to keep the parallel branch readable when reading
// `items[index]` from inside an async lambda.
function item(items: unknown[], index: number): unknown {
	return items[index];
}
