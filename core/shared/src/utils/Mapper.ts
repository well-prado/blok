import _ from "lodash";
import type Context from "../types/Context";
import type FunctionContext from "../types/FunctionContext";
import type ParamsDictionary from "../types/ParamsDictionary";
import type VarsContext from "../types/VarsContext";
import { MapperResolutionError } from "./MapperResolutionError";

/**
 * Mapper — the workflow input resolver.
 *
 * Every step's `inputs` object is walked by `replaceObjectStrings`
 * before the step runs (see `NodeBase.process` → `blueprintMapper`).
 * Two template syntaxes are recognised:
 *
 * 1. **`${path.to.value}`** — interpolated string placeholder.
 *    Resolved via lodash `_.get(data, key)` first, with a JS-eval
 *    fallback when the key is not in `data`. Multiple placeholders
 *    in one string are concatenated.
 *
 * 2. **`"js/..."`** — full-string JS expression. The string is
 *    replaced ENTIRELY by the result of evaluating the expression
 *    (after stripping the `js/` prefix) against the live `ctx`.
 *    Returns whatever value the expression produces (string, number,
 *    object, array, etc.) — preserves type fidelity end-to-end.
 *
 * Both syntaxes evaluate inside a sandboxed `Function` with these
 * names in scope: `ctx`, `data`, `func`, `vars`. (Symmetric scope
 * across both syntaxes since v0.3.x — pre-v0.3.x `${...}` evaluator
 * lacked `func`+`vars`, leading to surprising scope mismatches.)
 *
 * ## Failure modes — see {@link MapperResolutionError}
 *
 * Resolution failures (typo, undefined access, syntax error) used to
 * be swallowed silently with a noisy `console.log("Mapper Error N", e)`
 * — and worse, the unresolved expression string passed through to the
 * node, producing silent miscompiles downstream. Since v0.3.x the
 * Mapper packages every failure in a `MapperResolutionError` with full
 * context (workflow, step, expression, underlying cause + heuristic
 * hint) and routes it according to `BLOK_MAPPER_MODE`:
 *
 * - `"warn"` (default) — log via `ctx.logger.logLevel("warn", ...)`,
 *   pass through the original string. Backward-compatible diagnostics.
 * - `"strict"` — throw the error, fail the step fast. **Recommended
 *   for production.**
 * - `"silent"` — full suppression. Tests / opt-out only.
 *
 * ## Bug fixes shipped alongside the diagnostic upgrade (v0.3.x)
 *
 * - **Falsy values now preserved** — `_.get(data, key) || runJs(...)`
 *   used to fall through to `runJs` when the lookup returned `0`,
 *   `false`, `null`, or `""` (all valid values incorrectly treated
 *   as missing). Now uses an explicit `=== undefined` check.
 * - **Object interpolation now JSON-encodes** — `value as string`
 *   used to produce `"[object Object]"` for object values. Now
 *   round-trips via `JSON.stringify`.
 * - **`js/` prefix stripping** uses `slice(3)` instead of
 *   `replace("js/", "")` (the latter only strips the FIRST
 *   occurrence — fragile if the expression itself contained `js/`).
 */

// =============================================================================
// Public types
// =============================================================================

/**
 * How the Mapper reacts to expression resolution failures. Read from
 * the `BLOK_MAPPER_MODE` env var at every call (no caching) so unit
 * tests can flip the mode between cases.
 */
export type MapperMode = "warn" | "strict" | "silent";

// =============================================================================
// Internal sentinels + helpers
// =============================================================================

/**
 * Returned by the template-resolution path to signal "this placeholder
 * could not be resolved; leave the literal `${...}` in place". Using a
 * Symbol avoids ambiguity with the legitimate `undefined` value an
 * expression might produce.
 */
const TEMPLATE_RESOLUTION_FAILED: unique symbol = Symbol("TEMPLATE_RESOLUTION_FAILED");

function readMode(): MapperMode {
	const raw = process.env.BLOK_MAPPER_MODE;
	if (raw === "strict") return "strict";
	if (raw === "silent") return "silent";
	return "warn";
}

function readStepContext(ctx: Context): { workflowName?: string; stepName?: string } {
	const ctxAny = ctx as unknown as Record<string, unknown>;
	const stepInfo = ctxAny._stepInfo as { name?: unknown } | undefined;
	const stepName = typeof stepInfo?.name === "string" ? stepInfo.name : undefined;
	const workflowName = typeof ctx.workflow_name === "string" ? ctx.workflow_name : undefined;
	return { workflowName, stepName };
}

/**
 * Build the actionable error message — every line carries information
 * a developer can act on: WHERE it failed, WHAT failed, WHY it likely
 * failed, and HOW to fix it.
 */
function buildErrorMessage(opts: {
	expression: string;
	syntax: "js" | "template";
	workflowName?: string;
	stepName?: string;
	cause: unknown;
}): string {
	const wf = opts.workflowName ?? "<unknown workflow>";
	const step = opts.stepName ?? "<unknown step>";
	const literal = opts.syntax === "js" ? `js/${opts.expression}` : `\${${opts.expression}}`;
	const causeMsg = opts.cause instanceof Error ? opts.cause.message : String(opts.cause);
	const hint = guessHint(opts.expression, causeMsg);
	const lines = [
		`[blok][mapper] Failed to resolve \`${literal}\` in step "${step}" of workflow "${wf}"`,
		`  underlying: ${causeMsg}`,
	];
	if (hint) lines.push(`  hint: ${hint}`);
	lines.push(
		"  fix: verify the referenced ctx path exists at run time. Set BLOK_MAPPER_MODE=strict in production to fail fast on these errors.",
	);
	return lines.join("\n");
}

/**
 * Heuristic — translate common JS evaluation errors into actionable
 * developer hints. Returns `null` when the error doesn't match any
 * known pattern (the underlying message is still surfaced).
 */
function guessHint(expression: string, errorMessage: string): string | null {
	// Most common case — `Cannot read properties of undefined (reading 'X')`
	// or the older `Cannot read property 'X' of undefined`. Both forms
	// appear depending on Node/Bun version.
	const undefMatch = errorMessage.match(
		/Cannot read propert(?:y '(\w+)' of undefined|ies of undefined \(reading '(\w+)'\))/,
	);
	if (undefMatch) {
		const prop = undefMatch[1] ?? undefMatch[2];
		const segments = expression.split(".");
		const parent = segments.slice(0, -1).join(".") || expression;
		return `the path \`${parent}\` is undefined or doesn't have a "${prop}" field at run time. Check the trigger payload (ctx.req.body) or the upstream step's output (ctx.state.<id>).`;
	}
	// Identifier not in scope — only `ctx`, `data`, `func`, `vars` are
	// available inside expressions.
	const refMatch = errorMessage.match(/(\w+) is not defined/);
	if (refMatch) {
		return `\`${refMatch[1]}\` is not in scope. Available identifiers inside expressions: ctx, data, func, vars.`;
	}
	// Syntax error.
	if (/SyntaxError/.test(errorMessage) || /Unexpected token/.test(errorMessage)) {
		return "the expression is not valid JavaScript. Check for typos, unmatched parentheses, or stray characters.";
	}
	return null;
}

/**
 * Route a warn-mode log line to the best available sink. Prefers
 * `ctx.logger.logLevel("warn", ...)` so the warning lands in BOTH the
 * console (via DefaultLogger) AND Studio's log viewer (via
 * TracingLogger.normalizeLevel → addLog). Falls back to console.warn
 * when no logger is attached (early-boot or hand-rolled test ctx).
 */
function logViaCtxOrConsole(ctx: Context, message: string): void {
	const logger = ctx.logger as
		| {
				logLevel?: (level: string, message: string) => void;
				log?: (message: string) => void;
		  }
		| undefined;
	if (logger?.logLevel) {
		try {
			logger.logLevel("warn", message);
			return;
		} catch {
			// fall through to console.warn — never let logging itself crash a step.
		}
	}
	if (logger?.log) {
		try {
			logger.log(message);
			return;
		} catch {
			// fall through
		}
	}
	console.warn(message);
}

/**
 * Coerce a resolved value to its string form for `${...}` interpolation.
 *
 * Pre-v0.3.x used `value as string` which fell back to `String(value)`
 * via implicit coercion — producing `"[object Object]"` for any object/
 * array. Now JSON-encodes complex values so interpolated strings
 * preserve information instead of silently miscompiling.
 *
 * - `null` / `undefined` → empty string (matches user intent for
 *   missing optional fields)
 * - `string` → identity
 * - `number` / `boolean` / `bigint` → `String(value)`
 * - everything else → `JSON.stringify(value)` with a defensive fallback
 *   to `String(value)` for circular structures.
 */
function toInterpolatedString(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		// JSON.stringify throws on circular references — degrade gracefully.
		return String(value);
	}
}

/**
 * Is `value` a plain container the mapper may safely recurse into — a plain
 * object (prototype `Object.prototype` or null) or an array? Class instances
 * (RunnerNode, SubworkflowNode, WorkflowV2Builder, Date, Buffer, Map, …) have
 * a custom prototype and are NOT recursed: step inputs are always plain data,
 * and recursing into framework instances can reach internal object graphs
 * (e.g. `globalOptions.workflows`) that must never be resolved as inputs.
 */
function isPlainContainer(value: object): boolean {
	if (Array.isArray(value)) return true;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

// =============================================================================
// Mapper
// =============================================================================

class Mapper {
	/**
	 * Walk an object recursively, resolving every string value via
	 * `replaceString`. Mutates in place. Used by `NodeBase.process` to
	 * resolve a step's `inputs` against the live `ctx` before the
	 * step runs.
	 *
	 * Plain object/array values are recursed into; primitive non-string
	 * values are left untouched. Null values are NOT recursed (avoids
	 * a TypeError on `for (const k in null)`).
	 *
	 * **CLASS INSTANCES ARE NOT RECURSED.** Step `inputs` are always plain
	 * JSON-like data, so resolution is unaffected. But a step's resolved
	 * config can embed framework objects with custom prototypes — most
	 * dangerously a `SubworkflowNode` instance (inside a forEach `steps`
	 * array) whose `globalOptions.workflows` holds EVERY registered
	 * workflow's definition. Recursing into those made the mapper evaluate
	 * (and mutate, in place) every OTHER workflow's `js/...` expressions
	 * against the current ctx — surfacing as `Failed to resolve` errors
	 * referencing an unrelated workflow's expression, or a hard failure in
	 * strict mode. Limiting recursion to plain containers cuts that whole
	 * object graph off at the boundary. (Regression: cross-workflow
	 * expression leak via forEach + subworkflow.)
	 */
	public replaceObjectStrings(obj: ParamsDictionary, ctx: Context, data: ParamsDictionary): void {
		for (const key in obj) {
			if (Object.prototype.hasOwnProperty.call(obj, key)) {
				const value = obj[key];
				if (typeof value === "string") {
					// `ParamsDictionary[key]` is typed `string`, but the
					// runtime contract has always been "the resolved value
					// keeps its actual type" (so `js/ctx.req.body.count`
					// produces a number, not the string "42"). The
					// `as unknown as string` boundary cast acknowledges
					// that the type system can't express this widening
					// without changing the global ParamsDictionary shape
					// (a much larger refactor).
					obj[key] = this.replaceString(value, ctx, data) as unknown as string;
				} else if (value !== null && typeof value === "object" && isPlainContainer(value)) {
					this.replaceObjectStrings(value as unknown as ParamsDictionary, ctx, data);
				}
			}
		}
	}

	/**
	 * Resolve a single string. Returns `unknown` because a `js/...`
	 * expression may yield any value (number, object, array, etc.) —
	 * type fidelity is preserved across the resolver boundary.
	 *
	 * Pre-v0.3.x return was typed as `string` via `as string` cast
	 * which was a type lie; downstream consumers received the actual
	 * runtime value but couldn't see it through the type system.
	 */
	public replaceString = (strData: string, ctx: Context, data: ParamsDictionary): unknown => {
		let str = strData;

		// === 1. `${path}` template interpolation ===
		const regex = /\${(.*?)}/g;
		const matches = str.match(regex);
		if (matches) {
			for (const match of matches) {
				const key = match.slice(2, -1); // strip `${` and `}`
				const value = this.resolveTemplateExpression(key, ctx, data);
				if (value !== TEMPLATE_RESOLUTION_FAILED) {
					str = str.replace(match, toInterpolatedString(value));
				}
				// On failure: leave the literal `${...}` placeholder in
				// place. The failure was already reported per the active
				// mode (warn/strict/silent).
			}
		}

		// === 2. `js/...` full-string evaluation ===
		return this.jsMapper(str, ctx, data);
	};

	/**
	 * Resolve a `${path}` expression. Lodash lookup first; JS-eval
	 * fallback when the path is not in `data`. Returns the resolved
	 * value OR the failure sentinel.
	 */
	private resolveTemplateExpression(
		key: string,
		ctx: Context,
		data: ParamsDictionary,
	): unknown | typeof TEMPLATE_RESOLUTION_FAILED {
		// Lodash lookup. Use explicit `=== undefined` instead of `||`
		// so falsy-but-valid values (0, false, "", null) are preserved.
		const lookupValue = _.get(data, key);
		if (lookupValue !== undefined) return lookupValue;

		// Fallback to JS evaluation against ctx. Symmetric with jsMapper:
		// pass `ctx.func` and `ctx.vars` so `${func.X}` and `${vars.X}`
		// have the same scope as `js/func.X` / `js/vars.X`.
		try {
			return this.runJs(key, ctx, data, (ctx.func ?? {}) as FunctionContext, (ctx.vars ?? {}) as VarsContext);
		} catch (cause) {
			const stepCtx = readStepContext(ctx);
			const error = new MapperResolutionError(
				buildErrorMessage({ expression: key, syntax: "template", ...stepCtx, cause }),
				{ expression: key, syntax: "template", ...stepCtx, cause },
			);
			this.handleResolutionError(ctx, error);
			return TEMPLATE_RESOLUTION_FAILED;
		}
	}

	/**
	 * Evaluate a `js/...` full-string expression. Returns whatever the
	 * expression produces (any type), or — in warn/silent mode on
	 * failure — the original literal `js/...` string.
	 *
	 * Strict-mode failures throw `MapperResolutionError`.
	 */
	private jsMapper(str: string, ctx: Context, data: ParamsDictionary): unknown {
		if (typeof str !== "string" || !str.startsWith("js/")) return str;
		// `slice(3)` strips exactly the leading `js/` prefix.
		// Pre-v0.3.x used `replace("js/", "")` which only strips the
		// FIRST occurrence — fragile if the expression itself contained
		// the substring `js/` (e.g., a URL like `https://js/foo`).
		const expression = str.slice(3);
		try {
			return this.runJs(expression, ctx, data, (ctx.func ?? {}) as FunctionContext, (ctx.vars ?? {}) as VarsContext);
		} catch (cause) {
			const stepCtx = readStepContext(ctx);
			const error = new MapperResolutionError(buildErrorMessage({ expression, syntax: "js", ...stepCtx, cause }), {
				expression,
				syntax: "js",
				...stepCtx,
				cause,
			});
			this.handleResolutionError(ctx, error);
			return str; // pre-v0.3.x behavior — pass through the literal string
		}
	}

	/**
	 * Apply the configured mode (`BLOK_MAPPER_MODE`) to a resolution
	 * failure. In strict mode, the error escapes here and propagates
	 * up through `replaceString` → `NodeBase.blueprintMapper` →
	 * `NodeBase.process` → step error envelope.
	 */
	private handleResolutionError(ctx: Context, error: MapperResolutionError): void {
		const mode = readMode();
		if (mode === "strict") throw error;
		if (mode === "silent") return;
		// mode === "warn"
		logViaCtxOrConsole(ctx, error.message);
	}

	/**
	 * Sandboxed JS evaluation. Compiles the expression as a function
	 * body returning the expression value; binds `ctx`, `data`, `func`,
	 * `vars` as positional arguments; runs in `"use strict"` mode.
	 *
	 * Throws on any evaluation error (typo, undefined access, syntax,
	 * unknown identifier). Callers wrap in try/catch and translate to
	 * `MapperResolutionError`.
	 *
	 * Public via the prototype but documented as internal — the only
	 * supported call sites are inside this class.
	 */
	private runJs(
		str: string,
		ctx: Context,
		data: ParamsDictionary = {},
		func: FunctionContext = {},
		vars: VarsContext = {},
	): unknown {
		// Function constructor (NOT eval) — creates a fresh function
		// scope without lexical access to the surrounding module. Same
		// security profile as the v1 implementation.
		return Function("ctx", "data", "func", "vars", `"use strict";return (${str});`)(ctx, data, func, vars);
	}
}

export default new Mapper();
