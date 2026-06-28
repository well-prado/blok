/**
 * LoopNode — v0.5 primitive. While-loop with hard maxIterations safety
 * cap. Runs a sub-pipeline as long as the `while` condition evaluates
 * truthy against the live ctx. Each iteration carries forward state
 * mutations (sequential by definition) so condition variables can
 * advance between iterations.
 *
 * The runtime config is read from `ctx.config[this.name]`:
 *   {
 *     while: string,          // JS expression evaluated against ctx
 *     maxIterations: number,  // hard safety cap; throws LoopMaxIterationsError on hit
 *     steps: NodeBase[],      // pre-resolved by Configuration's isFlowWithProperties path
 *   }
 *
 * The loop counter is exposed as `ctx.state[<stepId>Index]` (0-based)
 * so the `while` expression can reference it. Each iteration's final
 * step output is the loop step's overall data (the last iteration's
 * `ctx.response.data`).
 */

import type { Context, ResponseContext } from "@blokjs/shared";
import _ from "lodash";
import { LoopMaxIterationsError } from "./LoopMaxIterationsError";
import RunnerNode from "./RunnerNode";
import {
	type PrimitiveStackFrame,
	consumeRehydratedCursor,
	popPrimitiveFrame,
	pushPrimitiveFrame,
	readRehydratedCursor,
} from "./runtime/PrimitiveStack";
import type { SequentialIterationContext } from "./tracing/types";
import { applyStepOutput } from "./workflow/PersistenceHelper";

interface LoopOpts {
	while?: string;
	maxIterations?: number;
	steps?: RunnerNode[];
}

/**
 * v0.6 wait-inside-primitives Phase 3 — resume hint set on ctx by
 * `TriggerBase.run` after rehydrating the loop NodeRun's
 * `iteration_context` column. LoopNode reads it on entry and:
 *
 *   - Starts the while-loop at `iteration` instead of 0 so the
 *     iterations [0..iteration-1] that already completed in a prior
 *     pass are not re-executed (idempotency is not required because
 *     they're skipped, not re-run).
 *   - Resumes iteration `iteration` from the inner step at
 *     `innerStepIndex` (the step that was about to throw the wait
 *     when the previous pass deferred). The inner runner picks up
 *     this hint from `_blokInnerResumeIndex` on the child ctx.
 *
 * Unlike ForEach, Loop does NOT aggregate iteration results — it
 * returns the LAST iteration's output. The cursor's `completedResults`
 * field is preserved at the schema level for forward-compat but
 * unused on Loop resume (the rehydrated `ctx.state` already carries
 * state mutations from completed iterations).
 */
interface LoopResume {
	iteration: number;
	innerStepIndex: number;
	// Preserved at the schema layer for forward-compat with ForEach. Loop
	// ignores it on resume because state-via-shared-reference already
	// carries iteration mutations forward.
	completedResults?: unknown[];
}

const DEFAULT_MAX_ITERATIONS = 1000;

export class LoopNode extends RunnerNode {
	/**
	 * v0.6 marker — RunnerSteps stamps `_blokActivePrimitiveNodeRunId`
	 * on ctx around `step.process()` calls when this flag is true so a
	 * nested wait fired inside an iteration body knows which NodeRun to
	 * write its `iteration_context` cursor to. Mirrors ForEachNode's
	 * marker (Phase 2). Static `true` (vs an instance method) avoids
	 * importing LoopNode inside RunnerSteps, which would create a
	 * circular dependency.
	 */
	public readonly isPrimitiveIterator = true;

	async run(ctx: Context): Promise<ResponseContext> {
		this.contentType = "application/json";
		const response: ResponseContext = { success: true, data: null, error: null };

		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as LoopOpts;
		const whileExpr = typeof opts.while === "string" ? opts.while : "false";
		const envCap = process.env.BLOK_LOOP_MAX_ITERATIONS
			? Number.parseInt(process.env.BLOK_LOOP_MAX_ITERATIONS, 10)
			: undefined;
		const maxIterations =
			typeof opts.maxIterations === "number" && opts.maxIterations > 0
				? opts.maxIterations
				: envCap && envCap > 0
					? envCap
					: DEFAULT_MAX_ITERATIONS;
		const steps = (opts.steps ?? []) as RunnerNode[];

		if (steps.length === 0) {
			return response;
		}

		// v0.6 — read the resume hint. Phase 4 — cursors are keyed by
		// NodeRun id in the rehydrated map so a loop nested inside
		// another primitive (or vice versa) finds its OWN cursor.
		// Falls back to the legacy single-slot field for back-compat.
		const ctxAny = ctx as Record<string, unknown>;
		const myNodeRunId = ctxAny._traceNodeId as string | undefined;
		// Phase 4 — lookup by step NAME (stable across re-entries).
		let resume: LoopResume | undefined = readRehydratedCursor(ctx, this.name) as LoopResume | undefined;
		if (resume) {
			consumeRehydratedCursor(ctx, this.name);
		}
		if (resume === undefined) {
			const legacyResume = ctxAny._blokIterationResume as LoopResume | undefined;
			if (legacyResume !== undefined) {
				resume = legacyResume;
				ctxAny._blokIterationResume = undefined;
			}
		}

		const { default: Runner } = await import("./Runner");

		const counterKey = `${this.name}Index`;
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		let iteration = resume?.iteration ?? 0;
		let lastData: unknown = null;

		// v0.6 Phase 4 — push a primitive frame for THIS loop so a
		// nested wait persists THIS loop's iteration cursor to THIS
		// loop's NodeRun (and outer primitives' cursors to THEIRS).
		// Loop returns the LAST iteration's output, so `completedResults`
		// is always `[]` — preserved at schema level for parity with
		// forEach.
		const initialCursor: SequentialIterationContext = {
			mode: "sequential",
			iteration: 0,
			innerStepIndex: 0,
			completedResults: [],
		};
		const frame: PrimitiveStackFrame | undefined = myNodeRunId
			? { nodeRunId: myNodeRunId, cursor: initialCursor }
			: undefined;
		if (frame) pushPrimitiveFrame(ctx, frame);

		try {
			while (true) {
				state[counterKey] = iteration;

				// v0.6 Phase 3 — on the first iteration after a wait-resume,
				// skip the while-condition check. The condition was already
				// TRUE when the wait fired (otherwise iter N wouldn't have
				// started), and we've committed to finishing iter N's body
				// — re-evaluating now would compare against post-iter-N
				// state (e.g. a counter advanced by the pre-wait steps) and
				// could falsely terminate the loop. Subsequent iterations
				// re-check normally.
				const isFirstIterationAfterResume = resume !== undefined && iteration === resume.iteration;
				if (!isFirstIterationAfterResume) {
					// Re-clone config each iteration so mapper-resolved
					// values from prior iterations don't bleed into the
					// next condition eval.
					const evalCtx = { ...ctx, config: _.cloneDeep(ctx.config) } as Context;
					const shouldContinue = this.evaluateCondition(whileExpr, evalCtx);
					if (!shouldContinue) break;
				}

				if (iteration >= maxIterations) {
					throw new LoopMaxIterationsError(this.name, maxIterations, iteration);
				}

				// v0.6 Phase 4 — update the frame cursor before launching
				// the iteration body. The wait-throw site walks the stack
				// and writes the cursor; the TOP frame is THIS loop's,
				// so we need `iteration` to point at the in-flight pass.
				if (frame) {
					(frame.cursor as SequentialIterationContext).iteration = iteration;
				}

				const childCtx = this.cloneCtxForIteration(ctx);
				// v0.5.3 — stash iteration index on the per-iteration
				// child ctx so RunnerSteps propagates it to
				// NodeRun.iterationIndex (Studio groups inner steps under
				// "iteration N" headers).
				(childCtx as Record<string, unknown>)._blokIterationIndex = iteration;
				// v0.6 Phase 3 — pass the inner-step resume cursor on the
				// child ctx for the first iteration after resume.
				// Phase 4 — propagate the index-0 case so the deep
				// runSteps' wait re-entry detection sees innerResumeIndex
				// defined even when the wait is at body[0].
				if (isFirstIterationAfterResume && resume !== undefined) {
					(childCtx as Record<string, unknown>)._blokInnerResumeIndex = resume.innerStepIndex;
				}
				const runner = new Runner(steps);
				// `deep: true` — inner pipelines must not inherit the
				// outer run's `lastCompletedStepIndex` cursor.
				await runner.run(childCtx, { deep: true, stepName: this.name });
				// Carry state forward into the parent ctx so subsequent
				// iterations see updates.
				const childState = (childCtx.state ?? {}) as Record<string, unknown>;
				for (const [k, v] of Object.entries(childState)) {
					state[k] = v;
				}
				lastData = childCtx.response;
				iteration++;
			}

			response.data = lastData;
			// Persist to ctx.state[this.name] (see ForEachNode comment).
			applyStepOutput(ctx, this, { data: lastData });
			return response;
		} finally {
			// v0.6 Phase 4 — always pop so sibling loops / outer
			// runSteps see a clean stack, including on wait re-throw.
			if (frame) popPrimitiveFrame(ctx);
		}
	}

	private evaluateCondition(expr: string, ctx: Context): unknown {
		const data = (ctx.response?.data ?? ctx.request?.body ?? {}) as Record<string, unknown>;
		const vars = (ctx.vars ?? {}) as Record<string, unknown>;
		try {
			const fn = new Function("ctx", "data", "vars", `"use strict";return (${expr});`);
			return fn(ctx, data, vars) as unknown;
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			throw new Error(
				`[blok] loop "${this.name}" while condition failed: ${reason}. Loop while expressions only bind ctx, data, and vars; func.* is only available in Mapper-resolved step inputs.`,
			);
		}
	}

	private cloneCtxForIteration(ctx: Context): Context {
		// State is shared by reference (mutations carry forward — that's
		// the loop semantic). Config is deep-cloned so mapper resolutions
		// don't bleed across iterations.
		const config = _.cloneDeep(ctx.config);
		return {
			...ctx,
			config,
			response: { data: null, success: true, error: null, contentType: "application/json" },
		} as Context;
	}
}
