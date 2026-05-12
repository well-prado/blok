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
import {
	type PrimitiveStackFrame,
	consumeRehydratedCursor,
	popPrimitiveFrame,
	pushPrimitiveFrame,
	readRehydratedCursor,
} from "./runtime/PrimitiveStack";
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

		// v0.6 — read the resume hint that TriggerBase rehydrated.
		//
		// Phase 4 — cursors are now keyed by NodeRun id in a map on ctx
		// (`_blokIterationCursors`). Each primitive looks itself up by
		// `ctx._traceNodeId` so nested primitives (forEach > forEach,
		// switch > forEach, etc.) each find their OWN cursor — not the
		// previous Phase 2/3 single-slot model that lost outer cursors
		// to inner overwrites. Falls back to the legacy single-slot
		// `_blokIterationResume` field for first-pass compatibility with
		// callers that haven't migrated yet.
		const ctxAny = ctx as Record<string, unknown>;
		const myNodeRunId = ctxAny._traceNodeId as string | undefined;
		// Phase 4 — lookup by step NAME (not NodeRun id). Names are
		// stable across dispatchDeferred re-entries; NodeRun ids change.
		let resume: IterationContext | undefined = readRehydratedCursor(ctx, this.name);
		if (resume) {
			consumeRehydratedCursor(ctx, this.name);
		}
		if (resume === undefined) {
			const legacyResume = ctxAny._blokIterationResume as IterationContext | undefined;
			if (legacyResume !== undefined) {
				resume = legacyResume;
				ctxAny._blokIterationResume = undefined;
			}
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
			// child ctx. Phase 4 — propagate even the index-0 case so
			// the wait-re-entry detection can distinguish a resumed
			// iteration (innerResumeIndex defined) from a fresh one.
			if (innerResumeIndex !== undefined) {
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

		// v0.6 Phase 4 — push a primitive frame onto the ctx stack so the
		// wait-throw site (and parallel-branch cursor writer) persists
		// THIS forEach's iteration cursor to THIS forEach's NodeRun.
		// Nested primitives (forEach > forEach, switch > forEach, etc.)
		// each push their own frame, which is what unblocks the
		// `forEach > forEach > wait` shape that the Phase 2/3 single-slot
		// machinery couldn't represent.
		const initialCursor: IterationContext =
			mode === "parallel"
				? {
						mode: "parallel",
						waitFiringIteration: 0,
						innerStepIndex: 0,
						completedResults: [],
						cancelledIterations: [],
					}
				: { mode: "sequential", iteration: 0, innerStepIndex: 0, completedResults: [] };
		const frame: PrimitiveStackFrame | undefined = myNodeRunId
			? { nodeRunId: myNodeRunId, cursor: initialCursor }
			: undefined;
		if (frame) pushPrimitiveFrame(ctx, frame);

		try {
			if (mode === "sequential") {
				// v0.6 Phase 2 — start at the resume iteration if present,
				// else 0. Iterations before the resume index are not re-run;
				// their results were rehydrated above.
				const startIndex = sequentialResume?.iteration ?? 0;
				for (let i = startIndex; i < items.length; i++) {
					// v0.6 Phase 4 — update the frame cursor so a wait fired
					// from inside this iteration body lands the right snapshot
					// in `node_runs.iteration_context`. `completedResults`
					// reflects results-so-far so on resume we don't re-run
					// iterations that already finished before the wait.
					if (frame) {
						const seq = frame.cursor as SequentialIterationContext;
						seq.iteration = i;
						seq.completedResults = results.slice(0, i);
					}
					const innerResumeIndex =
						i === startIndex && sequentialResume !== undefined ? sequentialResume.innerStepIndex : undefined;
					results[i] = await runIteration(items[i], i, innerResumeIndex);
				}
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
					// Phase 4 — propagate the index-0 case too.
					if (innerResumeIndex !== undefined) {
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
				const errors = allOutcomes.filter(
					(o): o is { kind: "error"; index: number; err: unknown } => o.kind === "error",
				);
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
					this.writeCursor(ctx, frame, cursor);

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
		} finally {
			// v0.6 Phase 4 — always pop the frame so sibling primitives
			// later in the workflow don't see a stale cursor pointer, AND
			// so a thrown WaitDispatchRequest unwind doesn't leave the
			// stack in an inconsistent state for the outer runSteps.
			if (frame) popPrimitiveFrame(ctx);
		}
	}

	/**
	 * Write the parallel cursor to the active forEach NodeRun's frame.
	 * Stamped from inside the parallel branch (vs. via RunnerSteps' wait-
	 * throw site) because the parallel cursor is built post-
	 * `Promise.allSettled` — the wait-throw site doesn't know which peer
	 * iterations got cancelled OR which completed.
	 *
	 * v0.6 Phase 4 — additionally mutates the frame's cursor in place so
	 * the wait-throw site (which runs AFTER this, when the throw unwinds
	 * back through RunnerSteps) re-persists the same parallel-shape
	 * cursor on outer-frame writes. Without the in-place mutation, the
	 * outer write would clobber this back to the initial parallel
	 * placeholder.
	 */
	private writeCursor(ctx: Context, frame: PrimitiveStackFrame | undefined, cursor: ParallelIterationContext): void {
		if (!frame) return;
		// Replace the in-stack cursor so any subsequent stack walk uses
		// the parallel-shape one we built (not the placeholder pushed at
		// run() entry).
		frame.cursor = cursor;
		const primitiveNodeRunId = frame.nodeRunId;
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
