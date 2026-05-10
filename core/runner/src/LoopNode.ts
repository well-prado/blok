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
import { applyStepOutput } from "./workflow/PersistenceHelper";

interface LoopOpts {
	while?: string;
	maxIterations?: number;
	steps?: RunnerNode[];
}

const DEFAULT_MAX_ITERATIONS = 1000;

export class LoopNode extends RunnerNode {
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

		const { default: Runner } = await import("./Runner");

		const counterKey = `${this.name}Index`;
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		let iteration = 0;
		let lastData: unknown = null;

		while (true) {
			state[counterKey] = iteration;

			// Re-clone config each iteration so mapper-resolved values from
			// prior iterations don't bleed into the next condition eval.
			const evalCtx = { ...ctx, config: _.cloneDeep(ctx.config) } as Context;
			const shouldContinue = this.evaluateCondition(whileExpr, evalCtx);
			if (!shouldContinue) break;

			if (iteration >= maxIterations) {
				throw new LoopMaxIterationsError(this.name, maxIterations, iteration);
			}

			const childCtx = this.cloneCtxForIteration(ctx);
			// v0.5.3 — stash iteration index on the per-iteration child ctx
			// so RunnerSteps can propagate it to NodeRun.iterationIndex.
			// Studio's StepRail uses this to group inner steps under
			// "iteration N" headers instead of rendering them flat. Set
			// here (not in cloneCtxForIteration) so the helper signature
			// stays parameter-free.
			(childCtx as Record<string, unknown>)._blokIterationIndex = iteration;
			const runner = new Runner(steps);
			// `deep: true` — inner pipelines must not inherit the outer
			// run's `lastCompletedStepIndex` cursor (PR 4 wait/resume).
			await runner.run(childCtx, { deep: true, stepName: this.name });
			// After Runner.runSteps, childCtx.response is the last step's
			// resolved data (RunnerSteps line ~349). Use it as the
			// iteration's output value.
			// Carry state forward into the parent ctx so subsequent
			// iterations see updates from this iteration's body.
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
	}

	private evaluateCondition(expr: string, ctx: Context): unknown {
		const data = (ctx.response?.data ?? ctx.request?.body ?? {}) as Record<string, unknown>;
		const vars = (ctx.vars ?? {}) as Record<string, unknown>;
		const fn = new Function("ctx", "data", "vars", `"use strict";return (${expr});`);
		return fn(ctx, data, vars) as unknown;
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
