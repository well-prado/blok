import { unwrapProxies } from "../proxy/$";
import type { V2BranchStep, V2Step, V2StepUi } from "../types/StepOpts";
import { conditionToExpr } from "./eq";

/**
 * Author-facing options for {@link branch}.
 *
 * `when` is evaluated at runtime as a raw JS expression against `ctx`
 * (`ctx.request`, `ctx.state.<id>`, `ctx.response`, …). A bare `$` proxy
 * compiles to a raw truthiness check; use {@link eq} / {@link gt} / friends for
 * comparisons.
 */
export interface BranchOpts {
	/** Stable identifier — visible in traces, referenced as `$.state[id]`. */
	id: string;
	/**
	 * JS condition evaluated against `ctx`. Truthy → run `then`; falsy →
	 * run `else`. Use a bare `$` proxy for truthiness, a comparator helper, or a
	 * raw `ctx.*` expression.
	 */
	when: string | unknown;
	then: V2Step[];
	/** Optional. Steps to run when `when` is falsy. */
	else?: V2Step[];
	/** Optional Studio/canvas metadata. Ignored by the runner. */
	ui?: V2StepUi;
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
 *   import { branch, eq, $ } from "@blokjs/helper";
 *   branch({
 *     id: "route",
 *     when: eq($.req.method, "POST"),   // → 'ctx.request.method === "POST"'
 *     then: [{ id: "create", use: "...", inputs: {...} }],
 *     else: [{ id: "read",   use: "...", inputs: {...} }]
 *   })
 *
 * @example
 *   // Truthiness check.
 *   branch({ id: "has-kind", when: $.req.query.kind, then: [...] })
 */
export function branch(opts: BranchOpts): V2BranchStep {
	if (!opts || typeof opts !== "object") {
		throw new Error("branch() requires an options object.");
	}
	if (!opts.id || typeof opts.id !== "string") {
		throw new Error("branch() requires a non-empty `id` string.");
	}
	if (opts.when === undefined || opts.when === null) {
		throw new Error(
			`branch("${opts.id}") requires a non-empty \`when\` string. Use a $ proxy path (e.g. $.req.query.kind), a comparator helper, or a raw ctx expression.`,
		);
	}
	const when = conditionToExpr(opts.when);
	if (typeof when !== "string" || when.length === 0) {
		throw new Error(
			`branch("${opts.id}") requires a non-empty \`when\` string. Use a $ proxy path (e.g. $.req.query.kind), a comparator helper, or a raw ctx expression.`,
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
		...(opts.ui !== undefined ? { ui: opts.ui } : {}),
	};
	if (opts.active === false) (result as V2BranchStep & { active: boolean }).active = false;
	if (opts.stop === true) (result as V2BranchStep & { stop: boolean }).stop = true;
	return result;
}
