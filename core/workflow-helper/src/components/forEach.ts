import { unwrapProxies } from "../proxy/$";
import type { V2ForEachStep, V2Step, V2StepUi } from "../types/StepOpts";

/**
 * Author-facing options for {@link forEach}.
 *
 * `in` accepts either a literal expression string (`"$.state.items"` or
 * `"js/ctx.state.items"`) or a `$` proxy expression that compiles to
 * the same string at definition time.
 *
 * `as` is the per-iteration variable name. Each iteration sets
 * `ctx.state[as]` to the current item and `ctx.state[as + "Index"]`
 * to the 0-based position. Avoid using a name that collides with
 * any step `id` in the surrounding workflow.
 */
export interface ForEachOpts {
	/** Stable identifier — visible in traces, referenced as `$.state[id]`. */
	id: string;
	/** Array source. Literal expression string or `$` proxy. */
	in: string | unknown;
	/**
	 * Per-iteration variable name. Each iteration sets `ctx.state[as] = item`
	 * and `ctx.state[as + "Index"] = i`. Must be a valid JS identifier
	 * (letters, digits, underscore; can't start with a digit).
	 */
	as: string;
	/** Sub-pipeline run for each item. */
	do: V2Step[];
	/** `"sequential"` (default) awaits each iteration; `"parallel"` runs with bounded concurrency. */
	mode?: "sequential" | "parallel";
	/** When `mode: "parallel"`, max concurrent inner pipelines. Default 10. */
	concurrency?: number;
	/** Optional Studio/canvas metadata. Ignored by the runner. */
	ui?: V2StepUi;
	/** Skip this step at runtime. Default true (active). */
	active?: boolean;
	/** Halt the workflow after this step completes. */
	stop?: boolean;
}

/**
 * Create a forEach step — iterate over a collection running a sub-pipeline
 * per item. Sequential by default; pass `mode: "parallel"` with a
 * `concurrency` cap for parallel fan-out.
 *
 * @example
 *   forEach({
 *     id: "process-items",
 *     in: $.req.body.items,
 *     as: "item",
 *     mode: "parallel",
 *     concurrency: 5,
 *     do: [
 *       { id: "reserve", use: "inventory-reserve", inputs: { sku: $.state.item.sku } },
 *     ],
 *   })
 */
export function forEach(opts: ForEachOpts): V2ForEachStep {
	if (!opts || typeof opts !== "object") {
		throw new Error("forEach() requires an options object.");
	}
	if (!opts.id || typeof opts.id !== "string") {
		throw new Error("forEach() requires a non-empty `id` string.");
	}
	if (opts.in === undefined) {
		throw new Error(`forEach("${opts.id}") requires \`in\` (the array source).`);
	}
	if (!opts.as || typeof opts.as !== "string") {
		throw new Error(`forEach("${opts.id}") requires \`as\` (the per-iteration variable name).`);
	}
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(opts.as)) {
		throw new Error(`forEach("${opts.id}") \`as\` must be a valid JS identifier (got "${opts.as}").`);
	}
	if (!Array.isArray(opts.do) || opts.do.length === 0) {
		throw new Error(`forEach("${opts.id}") requires \`do\` to be a non-empty array of steps.`);
	}
	if (opts.mode !== undefined && opts.mode !== "sequential" && opts.mode !== "parallel") {
		throw new Error(`forEach("${opts.id}") \`mode\` must be "sequential" or "parallel" when set.`);
	}
	if (opts.concurrency !== undefined) {
		if (typeof opts.concurrency !== "number" || opts.concurrency < 1 || !Number.isInteger(opts.concurrency)) {
			throw new Error(`forEach("${opts.id}") \`concurrency\` must be a positive integer.`);
		}
	}

	const inExpr = unwrapProxies(opts.in);
	const innerSteps = unwrapProxies(opts.do) as V2Step[];

	const result: V2ForEachStep = {
		id: opts.id,
		forEach: {
			in: inExpr,
			as: opts.as,
			do: innerSteps,
			...(opts.mode !== undefined ? { mode: opts.mode } : {}),
			...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
		},
		...(opts.ui !== undefined ? { ui: opts.ui } : {}),
	};
	if (opts.active === false) (result as V2ForEachStep & { active: boolean }).active = false;
	if (opts.stop === true) (result as V2ForEachStep & { stop: boolean }).stop = true;
	return result;
}
