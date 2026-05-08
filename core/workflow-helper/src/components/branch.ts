import { unwrapProxies } from "../proxy/$";
import type { V2BranchStep, V2Step } from "../types/StepOpts";

/**
 * Author-facing options for {@link branch}.
 *
 * `when` accepts either a plain string (`"$.req.method === 'POST'"`) or
 * a `$` proxy expression that will compile to a string at definition
 * time (`$.req.method`). Note that JavaScript's `===` operator can't be
 * intercepted, so equality comparisons must be expressed as strings.
 */
export interface BranchOpts {
	/** Stable identifier — visible in traces, referenced as `$.state[id]`. */
	id: string;
	/** JS condition. Truthy → run `then`; falsy → run `else`. */
	when: string | unknown;
	then: V2Step[];
	/** Optional. Steps to run when `when` is falsy. */
	else?: V2Step[];
	/** Skip this branch step at runtime. Default true (active). */
	active?: boolean;
	/** Halt the workflow after this branch step completes. */
	stop?: boolean;
}

/**
 * Create a branch step — a step that runs one of two sub-pipelines based
 * on a JS condition.
 *
 * Compiles down to today's `@blokjs/if-else` flow node at workflow load
 * time, so the runner core needs no change. Authors get a single primitive
 * with the same shape as a regular step: `{ id, ... }`.
 *
 * @example
 *   branch({
 *     id: "route",
 *     when: '$.req.method === "POST"',
 *     then: [{ id: "create", use: "...", inputs: {...} }],
 *     else: [{ id: "read",   use: "...", inputs: {...} }]
 *   })
 *
 * @example
 *   // `when` accepts a $ proxy expression — compiles to a string at
 *   // definition time, so `js/ctx.req.query.kind` lands in the workflow.
 *   branch({ id: "route-by-kind", when: $.req.query.kind, then: [...] })
 */
export function branch(opts: BranchOpts): V2BranchStep {
	if (!opts || typeof opts !== "object") {
		throw new Error("branch() requires an options object.");
	}
	if (!opts.id || typeof opts.id !== "string") {
		throw new Error("branch() requires a non-empty `id` string.");
	}
	const when = unwrapProxies(opts.when);
	if (typeof when !== "string" || when.length === 0) {
		throw new Error(
			`branch("${opts.id}") requires a non-empty \`when\` string. Use a $ proxy path (e.g. $.req.query.kind) or a plain expression (e.g. '$.req.method === "POST"'). For equality comparisons, use a plain string — JavaScript's === operator can't be intercepted by the proxy.`,
		);
	}
	if (!Array.isArray(opts.then)) {
		throw new Error(`branch("${opts.id}") requires \`then\` to be an array of steps.`);
	}
	if (opts.else !== undefined && !Array.isArray(opts.else)) {
		throw new Error(`branch("${opts.id}") \`else\` must be an array of steps when set.`);
	}

	// Walk the steps to convert any inline proxies in their inputs.
	const thenSteps = unwrapProxies(opts.then) as V2Step[];
	const elseSteps = opts.else ? (unwrapProxies(opts.else) as V2Step[]) : undefined;

	const result: V2BranchStep = {
		id: opts.id,
		branch: {
			when,
			then: thenSteps,
			...(elseSteps ? { else: elseSteps } : {}),
		},
	};
	if (opts.active === false) (result as V2BranchStep & { active: boolean }).active = false;
	if (opts.stop === true) (result as V2BranchStep & { stop: boolean }).stop = true;
	return result;
}
