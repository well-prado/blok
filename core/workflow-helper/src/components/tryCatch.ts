import type { V2Step, V2StepUi, V2TryCatchStep } from "../types/StepOpts";

/**
 * Author-facing options for {@link tryCatch}.
 *
 * `try` and `catch` are required and non-empty; `finally` is optional.
 *
 * Inside the `catch` block, `ctx.error.message`, `ctx.error.name`, and
 * `ctx.error.stack` resolve at run time to the captured error info. In
 * `try` and `finally`, `ctx.error` is undefined (the JS-like contract).
 */
export interface TryCatchOpts {
	/** Stable identifier — visible in traces, referenced as `ctx.state[id]`. */
	id: string;
	/** Sub-pipeline run first. If any step throws, control jumps to `catch`. */
	try: V2Step[];
	/**
	 * Sub-pipeline run when `try` throws. Has access to `ctx.error.{message,name,stack}`.
	 * Errors thrown inside `catch` propagate — they DO NOT re-trigger catch.
	 */
	catch: V2Step[];
	/**
	 * Sub-pipeline run unconditionally after try/catch. Runs even if `catch`
	 * itself throws. Errors thrown inside `finally` propagate.
	 */
	finally?: V2Step[];
	/** Optional Studio/canvas metadata. Ignored by the runner. */
	ui?: V2StepUi;
	/** Skip this step at runtime. Default true (active). */
	active?: boolean;
	/** Halt the workflow after this step completes. */
	stop?: boolean;
}

/**
 * Create a tryCatch step — JS-like exception handling for sub-pipelines.
 *
 * Semantics mirror JavaScript's `try/catch/finally`:
 * - `try` runs first.
 * - On throw, `ctx.error` is set and `catch` runs.
 * - `finally` runs unconditionally (after try success, after caught error,
 *   and after an uncaught throw from inside `catch`).
 * - State mutations from any block are visible to subsequent top-level steps.
 *
 * @example
 *   tryCatch({
 *     id: "signup-saga",
 *     try: [
 *       { id: "create", use: "user-create", inputs: { email: "js/ctx.request.body.email" } },
 *       { id: "notify", use: "email-send", inputs: { to: "js/ctx.state.create.email" } },
 *     ],
 *     catch: [
 *       branch({
 *         id: "rollback-if-needed",
 *         when: "ctx.state.create !== undefined",
 *         then: [{ id: "del", use: "user-delete", inputs: { userId: "js/ctx.state.create.id" } }],
 *       }),
 *       { id: "respond-fail", use: "@blokjs/respond",
 *         inputs: { status: 500, body: { error: "js/ctx.error.message" } } },
 *     ],
 *     finally: [
 *       { id: "metric", use: "@blokjs/metrics-emit",
 *         inputs: { event: "signup-attempt" } },
 *     ],
 *   })
 */
export function tryCatch(opts: TryCatchOpts): V2TryCatchStep {
	if (!opts || typeof opts !== "object") {
		throw new Error("tryCatch() requires an options object.");
	}
	if (!opts.id || typeof opts.id !== "string") {
		throw new Error("tryCatch() requires a non-empty `id` string.");
	}
	if (!Array.isArray(opts.try) || opts.try.length === 0) {
		throw new Error(`tryCatch("${opts.id}") requires \`try\` to be a non-empty array of steps.`);
	}
	if (!Array.isArray(opts.catch) || opts.catch.length === 0) {
		throw new Error(`tryCatch("${opts.id}") requires \`catch\` to be a non-empty array of steps.`);
	}
	if (opts.finally !== undefined) {
		if (!Array.isArray(opts.finally) || opts.finally.length === 0) {
			throw new Error(`tryCatch("${opts.id}") \`finally\` must be a non-empty array of steps when set.`);
		}
	}

	const tryBlock = opts.try as V2Step[];
	const catchBlock = opts.catch as V2Step[];
	const result: V2TryCatchStep = {
		id: opts.id,
		tryCatch: {
			try: tryBlock,
			catch: catchBlock,
			...(opts.finally !== undefined ? { finally: opts.finally as V2Step[] } : {}),
		},
		...(opts.ui !== undefined ? { ui: opts.ui } : {}),
	};
	if (opts.active === false) (result as V2TryCatchStep & { active: boolean }).active = false;
	if (opts.stop === true) (result as V2TryCatchStep & { stop: boolean }).stop = true;
	return result;
}
