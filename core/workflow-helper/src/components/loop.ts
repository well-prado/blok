import { unwrapProxies } from "../proxy/$";
import type { V2LoopStep, V2Step } from "../types/StepOpts";

/**
 * Author-facing options for {@link loop}.
 *
 * `while` is a JS expression evaluated against `ctx` BEFORE each
 * iteration. Loop continues while truthy. The loop counter is exposed
 * as `ctx.state[<id>Index]` so the condition can reference it
 * (e.g. `$.state.pollIndex < 5`).
 *
 * `maxIterations` is a HARD cap that throws `LoopMaxIterationsError`
 * when exceeded — a safety net against infinite loops. Default 1000.
 */
export interface LoopOpts {
	/** Stable identifier. The loop counter is exposed as `ctx.state[<id>Index]`. */
	id: string;
	/**
	 * JS expression evaluated against ctx before each iteration. Loop
	 * continues while truthy.
	 */
	while: string | unknown;
	/** Sub-pipeline run each iteration. */
	do: V2Step[];
	/**
	 * Hard cap on iterations. Default 1000 (override via env
	 * `BLOK_LOOP_MAX_ITERATIONS`). Hitting the cap throws
	 * `LoopMaxIterationsError`.
	 */
	maxIterations?: number;
	/** Skip this step at runtime. Default true (active). */
	active?: boolean;
	/** Halt the workflow after this step completes. */
	stop?: boolean;
}

/**
 * Create a loop step — while-loop with a hard maxIterations safety cap.
 *
 * State mutations made inside the loop body carry forward to the next
 * iteration, so condition variables can advance. The current iteration
 * counter (0-based) is at `ctx.state[<id>Index]`.
 *
 * @example
 *   loop({
 *     id: "poll-job",
 *     while: '$.state["check-status"].status !== "done"',
 *     maxIterations: 60,
 *     do: [
 *       { id: "wait-tick", wait: { for: "2s" } },
 *       { id: "check-status", use: "@blokjs/api-call", inputs: { url: "..." } },
 *     ],
 *   })
 */
export function loop(opts: LoopOpts): V2LoopStep {
	if (!opts || typeof opts !== "object") {
		throw new Error("loop() requires an options object.");
	}
	if (!opts.id || typeof opts.id !== "string") {
		throw new Error("loop() requires a non-empty `id` string.");
	}
	const whileExpr = unwrapProxies(opts.while);
	if (typeof whileExpr !== "string" || whileExpr.length === 0) {
		throw new Error(
			`loop("${opts.id}") requires a non-empty \`while\` expression. Use a $ proxy path or a plain string expression.`,
		);
	}
	if (!Array.isArray(opts.do) || opts.do.length === 0) {
		throw new Error(`loop("${opts.id}") requires \`do\` to be a non-empty array of steps.`);
	}
	if (opts.maxIterations !== undefined) {
		if (typeof opts.maxIterations !== "number" || opts.maxIterations < 1 || !Number.isInteger(opts.maxIterations)) {
			throw new Error(`loop("${opts.id}") \`maxIterations\` must be a positive integer.`);
		}
	}

	const innerSteps = unwrapProxies(opts.do) as V2Step[];

	const result: V2LoopStep = {
		id: opts.id,
		loop: {
			while: whileExpr,
			do: innerSteps,
			...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
		},
	};
	if (opts.active === false) (result as V2LoopStep & { active: boolean }).active = false;
	if (opts.stop === true) (result as V2LoopStep & { stop: boolean }).stop = true;
	return result;
}
