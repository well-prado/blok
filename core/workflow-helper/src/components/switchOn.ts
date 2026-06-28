import { unwrapProxies } from "../proxy/$";
import type { V2Step, V2StepUi, V2SwitchStep } from "../types/StepOpts";

/**
 * Author-facing options for {@link switchOn}.
 *
 * `on` accepts either a `$` proxy expression (compiles to a `js/...`
 * string at definition time) or a literal value. Whatever it resolves
 * to at run time is matched against each `case.when`:
 *
 * - `when` is a literal scalar → match if `on === when`
 * - `when` is an array → match if `array.includes(on)` (group related cases)
 *
 * First matching case wins. Subsequent cases are not evaluated. If no
 * case matches and a `default` block is provided, those steps run instead.
 */
export interface SwitchCase {
	/**
	 * Match value. Literal scalar (number/string/boolean) for strict
	 * equality, or an array for any-of matching. Resolved by the
	 * blueprint mapper before comparison — `$` proxies and `js/...`
	 * strings are evaluated against the live ctx.
	 */
	when: unknown;
	/** Sub-pipeline run when this case matches. */
	do: V2Step[];
}

export interface SwitchOpts {
	/** Stable identifier — visible in traces, referenced as `$.state[id]`. */
	id: string;
	/**
	 * Value to match against. `$` proxy expression (`$.req.headers["x-tenant-id"]`),
	 * `js/...` string, or any literal. Resolved at run time before matching.
	 */
	on: unknown;
	/** Ordered list of cases. First match wins. */
	cases: SwitchCase[];
	/** Fallback sub-pipeline when no case matches. Optional. */
	default?: V2Step[];
	/** Optional Studio/canvas metadata. Ignored by the runner. */
	ui?: V2StepUi;
	/** Skip this step at runtime. Default true (active). */
	active?: boolean;
	/** Halt the workflow after this step completes. */
	stop?: boolean;
}

/**
 * Create a switch step — N-way branch keyed on a value. First matching
 * case wins; an optional `default` block runs when no case matches.
 *
 * Authoring note: the function is named `switchOn` because `switch` is
 * a JavaScript reserved word. The resulting step object's discriminator
 * field is `switch`, matching the JSON shape exactly.
 *
 * @example
 *   switchOn({
 *     id: "route-by-event",
 *     on: $.req.headers["x-github-event"],
 *     cases: [
 *       { when: "push", do: [{ id: "handle-push", subworkflow: "handle-push" }] },
 *       {
 *         when: ["pull_request", "pull_request_review"],
 *         do: [{ id: "handle-pr-event", subworkflow: "handle-pr-event" }],
 *       },
 *     ],
 *     default: [
 *       { id: "log-unknown", use: "@blokjs/log",
 *         inputs: { level: "warn", message: "unknown github event" } },
 *     ],
 *   })
 */
export function switchOn(opts: SwitchOpts): V2SwitchStep {
	if (!opts || typeof opts !== "object") {
		throw new Error("switchOn() requires an options object.");
	}
	if (!opts.id || typeof opts.id !== "string") {
		throw new Error("switchOn() requires a non-empty `id` string.");
	}
	if (opts.on === undefined) {
		throw new Error(`switchOn("${opts.id}") requires \`on\` (the value or expression to match against).`);
	}
	if (!Array.isArray(opts.cases) || opts.cases.length === 0) {
		throw new Error(`switchOn("${opts.id}") requires \`cases\` to be a non-empty array.`);
	}
	for (let i = 0; i < opts.cases.length; i++) {
		const c = opts.cases[i];
		if (!c || typeof c !== "object") {
			throw new Error(`switchOn("${opts.id}") cases[${i}] must be an object with \`when\` and \`do\`.`);
		}
		if (c.when === undefined) {
			throw new Error(`switchOn("${opts.id}") cases[${i}] is missing \`when\` (the match value).`);
		}
		if (!Array.isArray(c.do) || c.do.length === 0) {
			throw new Error(`switchOn("${opts.id}") cases[${i}] \`do\` must be a non-empty array of steps.`);
		}
	}
	if (opts.default !== undefined) {
		if (!Array.isArray(opts.default) || opts.default.length === 0) {
			throw new Error(`switchOn("${opts.id}") \`default\` must be a non-empty array of steps when set.`);
		}
	}

	const onExpr = unwrapProxies(opts.on);
	const cases = opts.cases.map((c) => ({
		when: unwrapProxies(c.when),
		do: unwrapProxies(c.do) as V2Step[],
	}));
	const result: V2SwitchStep = {
		id: opts.id,
		switch: {
			on: onExpr,
			cases,
			...(opts.default !== undefined ? { default: unwrapProxies(opts.default) as V2Step[] } : {}),
		},
		...(opts.ui !== undefined ? { ui: opts.ui } : {}),
	};
	if (opts.active === false) (result as V2SwitchStep & { active: boolean }).active = false;
	if (opts.stop === true) (result as V2SwitchStep & { stop: boolean }).stop = true;
	return result;
}
