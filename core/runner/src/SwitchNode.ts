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
 *
 * v0.6 Phase 4 — switch + wait support. The cursor schema
 * (`SwitchIterationContext`) records `caseIndex` (or -1 for `default`)
 * plus `innerStepIndex` within that arm. On re-entry after a wait,
 * SwitchNode reads its cursor from the rehydrated map (keyed by its
 * own NodeRun id), walks back into the matched arm at the right step,
 * and ignores the `on` value entirely — we already committed to a
 * specific arm in the first pass.
 */

import type { Context, ResponseContext } from "@blokjs/shared";
import RunnerNode from "./RunnerNode";
import {
	type PrimitiveStackFrame,
	consumeRehydratedCursor,
	popPrimitiveFrame,
	pushPrimitiveFrame,
	readRehydratedCursor,
} from "./runtime/PrimitiveStack";
import type { SwitchIterationContext } from "./tracing/types";
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

/** Sentinel `caseIndex` value meaning "the `default` arm matched". */
const DEFAULT_ARM = -1;

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

		// v0.6 Phase 4 — resume cursor lookup. On re-entry from a wait
		// fired inside a switch case, the persisted NodeRun's
		// iteration_context carries the matched arm + inner step index.
		const ctxAny = ctx as Record<string, unknown>;
		const myNodeRunId = ctxAny._traceNodeId as string | undefined;
		// Phase 4 — lookup by step NAME (stable across re-entries).
		const resumeRaw = readRehydratedCursor(ctx, this.name);
		const resume: SwitchIterationContext | undefined =
			resumeRaw && resumeRaw.mode === "switch" ? (resumeRaw as SwitchIterationContext) : undefined;
		if (resume) {
			consumeRehydratedCursor(ctx, this.name);
		}

		// Case selection. On resume, skip re-evaluating the `when`
		// expressions — we've already committed to a specific arm and
		// `on` could have changed mid-flight (different ctx state after
		// pre-wait mutations). Walk straight back into the cached arm.
		let selected: RunnerNode[] | undefined;
		let selectedCaseIndex = DEFAULT_ARM;
		if (resume !== undefined) {
			if (resume.caseIndex === DEFAULT_ARM) {
				selected = defaultSteps;
			} else if (resume.caseIndex >= 0 && resume.caseIndex < cases.length) {
				selected = cases[resume.caseIndex].steps;
				selectedCaseIndex = resume.caseIndex;
			}
			// Cursor pointed at an arm that no longer exists (case removed
			// between deploys, etc.). Fall through to fresh first-match
			// behaviour — better than crashing the resume.
		}
		if (selected === undefined && resume === undefined) {
			for (let idx = 0; idx < cases.length; idx++) {
				if (caseMatches(cases[idx].when, on)) {
					selected = cases[idx].steps;
					selectedCaseIndex = idx;
					break;
				}
			}
			if (selected === undefined) {
				selected = defaultSteps;
				if (selected !== undefined) selectedCaseIndex = DEFAULT_ARM;
			}
		}

		if (selected === undefined || selected.length === 0) {
			// No matching case + no default → no-op success. State
			// entry is `null` so downstream `$.state[<id>]` reads return
			// null (not undefined) — keeps the persistence model uniform.
			applyStepOutput(ctx, this, { data: null });
			// Preserve the previous step's ctx.response so the NEXT
			// top-level step doesn't dereference null when RunnerSteps
			// assigns `ctx.response.contentType`.
			response.data = ctx.response;
			return response;
		}

		// v0.6 Phase 4 — push a primitive frame so a nested wait fired
		// inside this case's sub-pipeline persists the cursor on
		// THIS switch's NodeRun. `innerStepIndex` is updated at each
		// step boundary inside the case body by RunnerSteps; we just
		// keep `caseIndex` pinned for the duration of this run.
		const initialCursor: SwitchIterationContext = {
			mode: "switch",
			caseIndex: selectedCaseIndex,
			innerStepIndex: resume?.innerStepIndex ?? 0,
			completedResults: [] as never[],
		};
		const frame: PrimitiveStackFrame | undefined = myNodeRunId
			? { nodeRunId: myNodeRunId, cursor: initialCursor }
			: undefined;
		if (frame) pushPrimitiveFrame(ctx, frame);

		try {
			// Lazy import — same circular-dep guard ForEach/Loop use.
			const { default: Runner } = await import("./Runner");
			const runner = new Runner(selected);

			// On resume, pass the inner-step resume index — INCLUDING
			// the index-0 case where the wait is the very first step
			// of the matched arm. The deep runSteps' wait re-entry
			// detection uses `innerResumeIndex !== undefined` as the
			// "this primitive resumed here" signal (Phase 4 fix).
			if (resume) {
				ctxAny._blokInnerResumeIndex = resume.innerStepIndex;
			}

			// `deep: true` so the inner runSteps doesn't inherit the
			// outer run's `lastCompletedStepIndex` cursor (PR 4 wait/
			// resume logic).
			await runner.run(ctx, { deep: true, stepName: this.name });

			// Switch is a passthrough — the matched case ran on the
			// parent ctx, so state mutations are already visible to
			// downstream steps. The switch step's own data is the last
			// inner step's response.
			const data = ctx.response;
			response.data = data;
			applyStepOutput(ctx, this, { data });
			return response;
		} finally {
			if (frame) popPrimitiveFrame(ctx);
		}
	}
}
