/**
 * SwitchNode — v0.5 primitive. N-way branch keyed on a value. First
 * matching case wins; an optional `default` block runs when no case
 * matches.
 *
 * The runtime config is read from `ctx.config[this.name]`:
 *   {
 *     on: unknown,                                      // resolved by mapper
 *     cases: [{ when, steps: NodeBase[] }],             // pre-resolved by Configuration
 *     default?: NodeBase[],                             // pre-resolved
 *   }
 *
 * Match semantics:
 * - `when` is a literal scalar (string/number/boolean) → match if `on === when`.
 * - `when` is an array → match if `array.includes(on)` (group related cases).
 *
 * Mutations to state inside the matched case's sub-pipeline DO carry
 * forward to subsequent top-level steps — switch is a passthrough flow,
 * NOT an isolation boundary like forEach. The matched case's last step
 * output becomes the switch step's `response.data`.
 *
 * If no case matches and there's no default, the step is a no-op
 * (success, data: null).
 */

import type { Context, ResponseContext } from "@blokjs/shared";
import RunnerNode from "./RunnerNode";
import { applyStepOutput } from "./workflow/PersistenceHelper";

interface SwitchCase {
	when: unknown;
	steps: RunnerNode[];
}

interface SwitchOpts {
	on?: unknown;
	cases?: SwitchCase[];
	default?: RunnerNode[];
}

function caseMatches(when: unknown, on: unknown): boolean {
	if (Array.isArray(when)) {
		return when.some((w) => w === on);
	}
	return when === on;
}

export class SwitchNode extends RunnerNode {
	async run(ctx: Context): Promise<ResponseContext> {
		this.contentType = "application/json";
		const response: ResponseContext = { success: true, data: null, error: null };

		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as SwitchOpts;
		const on = opts.on;
		const cases = Array.isArray(opts.cases) ? opts.cases : [];
		const defaultSteps = Array.isArray(opts.default) ? opts.default : undefined;

		// First-match-wins case selection.
		let selected: RunnerNode[] | undefined;
		for (const c of cases) {
			if (caseMatches(c.when, on)) {
				selected = c.steps;
				break;
			}
		}
		if (selected === undefined) selected = defaultSteps;

		if (selected === undefined || selected.length === 0) {
			// No matching case + no default → no-op success. State entry is
			// `null` so downstream `$.state[<id>]` reads return null (not
			// undefined) — keeps the persistence model uniform.
			applyStepOutput(ctx, this, { data: null });
			// Preserve the previous step's ctx.response so the NEXT top-level
			// step doesn't dereference null when RunnerSteps assigns
			// `ctx.response.contentType`. Returning data:null here would let
			// RunnerSteps unwrap to `ctx.response = null` and break the chain.
			response.data = ctx.response;
			return response;
		}

		// Lazy import — same circular-dep guard ForEach/Loop use.
		const { default: Runner } = await import("./Runner");
		const runner = new Runner(selected);
		// `deep: true` so the inner runSteps doesn't inherit the outer
		// run's `lastCompletedStepIndex` cursor (PR 4 wait/resume logic).
		await runner.run(ctx, { deep: true, stepName: this.name });

		// Switch is a passthrough — the matched case ran on the parent ctx,
		// so state mutations are already visible to downstream steps. The
		// switch step's own data is the last inner step's response.
		// (RunnerSteps sets ctx.response = model.data after each step, so
		// after the inner Runner finishes ctx.response IS the last step's
		// data — same convention ForEach/Loop rely on.)
		const data = ctx.response;
		response.data = data;
		applyStepOutput(ctx, this, { data });
		return response;
	}
}
