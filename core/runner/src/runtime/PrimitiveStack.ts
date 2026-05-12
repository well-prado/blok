/**
 * PrimitiveStack — v0.6 Phase 4 — runtime call stack of active
 * primitives (forEach, loop, switch) currently executing a sub-
 * pipeline.
 *
 * The Phase 1-3 single-slot machinery (`_blokActivePrimitiveNodeRunId`,
 * `_blokForEachCurrentIteration`, `_blokForEachPartialResults`)
 * could only track ONE primitive at a time. That's fine for
 * `forEach > wait` and `loop > wait`, but the moment a wait fires
 * inside `forEach > forEach > wait` (or `switch > forEach > wait`,
 * etc.) the inner primitive overwrites the outer's sentinels —
 * only the inner cursor lands in `node_runs.iteration_context`, and
 * the outer primitive resumes from iteration 0 instead of iteration
 * N. Phase 4 replaces the single-slot model with this stack so each
 * primitive writes its own NodeRun's cursor frame on wait-throw.
 *
 * Mechanics:
 *
 *   - **Each primitive pushes a frame on entry, pops in finally.**
 *     `cursor` is an `IterationContext` whose discriminator (`mode`)
 *     tells the persistence + resume code paths what shape to expect
 *     ("sequential" / "parallel" / "switch").
 *   - **The primitive owns the cursor's iteration/case state.** It
 *     updates `frame.cursor.iteration` (forEach/loop) or
 *     `frame.cursor.caseIndex` (switch) and
 *     `frame.cursor.completedResults` as the sub-pipeline progresses.
 *   - **RunnerSteps owns the inner-step cursor.** At each step
 *     boundary inside a deep runSteps, the runner sets the TOP
 *     frame's `cursor.innerStepIndex = i` so a wait fired at that step
 *     gets the right cursor written.
 *   - **The wait-throw site walks the whole stack** and persists each
 *     frame to its respective NodeRun. On resume, every primitive
 *     looks itself up by NodeRun id in the rehydrated cursor map
 *     (see `_blokIterationCursors` populated by `TriggerBase.run`).
 *
 * The stack lives on `ctx._blokPrimitiveStack` so the per-iteration
 * child-ctx shallow spread inside ForEachNode / LoopNode / SwitchNode
 * preserves the reference; pushes from a nested primitive are visible
 * to the outer runSteps because they share the array.
 */

import type { Context } from "@blokjs/shared";
import type { IterationContext } from "../tracing/types";

const STACK_KEY = "_blokPrimitiveStack";

export interface PrimitiveStackFrame {
	/** NodeRun id of the primitive that owns this frame. */
	nodeRunId: string;
	/** Iteration / case cursor — mutated in place as the sub-pipeline progresses. */
	cursor: IterationContext;
}

export function getPrimitiveStack(ctx: Context): PrimitiveStackFrame[] {
	const stack = (ctx as Record<string, unknown>)[STACK_KEY];
	if (Array.isArray(stack)) return stack as PrimitiveStackFrame[];
	return [];
}

export function pushPrimitiveFrame(ctx: Context, frame: PrimitiveStackFrame): void {
	const ctxAny = ctx as Record<string, unknown>;
	let stack = ctxAny[STACK_KEY] as PrimitiveStackFrame[] | undefined;
	if (!Array.isArray(stack)) {
		stack = [];
		ctxAny[STACK_KEY] = stack;
	}
	stack.push(frame);
}

export function popPrimitiveFrame(ctx: Context): PrimitiveStackFrame | undefined {
	const ctxAny = ctx as Record<string, unknown>;
	const stack = ctxAny[STACK_KEY] as PrimitiveStackFrame[] | undefined;
	if (!Array.isArray(stack) || stack.length === 0) return undefined;
	return stack.pop();
}

export function peekPrimitiveFrame(ctx: Context): PrimitiveStackFrame | undefined {
	const stack = getPrimitiveStack(ctx);
	if (stack.length === 0) return undefined;
	return stack[stack.length - 1];
}

/**
 * Read the cursor stamped onto `ctx._blokIterationCursors` for the
 * given primitive step name. The map is keyed by step NAME (not
 * NodeRun id) because NodeRun ids change on every dispatchDeferred
 * re-entry while step names are stable. Returns `undefined` when no
 * cursor was rehydrated (fresh run, no waits, sibling primitive).
 * After successful resume, primitives should call
 * {@link consumeRehydratedCursor} to clear the entry so sibling
 * primitives later in the workflow don't accidentally re-resume.
 */
export function readRehydratedCursor(ctx: Context, stepName: string): IterationContext | undefined {
	const map = (ctx as Record<string, unknown>)._blokIterationCursors;
	if (!(map instanceof Map)) return undefined;
	return (map as Map<string, IterationContext>).get(stepName);
}

export function consumeRehydratedCursor(ctx: Context, stepName: string): void {
	const map = (ctx as Record<string, unknown>)._blokIterationCursors;
	if (map instanceof Map) {
		(map as Map<string, IterationContext>).delete(stepName);
	}
}
