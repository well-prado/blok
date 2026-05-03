/**
 * Structured error thrown by `Mapper` when a workflow input expression
 * cannot be resolved against the live `Context`.
 *
 * The Mapper resolves two template syntaxes inside step `inputs`:
 * - **`${path.to.value}`** — interpolated string (lodash-path lookup
 *   with a JS-eval fallback)
 * - **`"js/..."`** — full-string JS evaluation against `ctx`
 *
 * When evaluation throws (typo, undefined access, syntax error,
 * unknown identifier), the Mapper packages the failure in a
 * `MapperResolutionError` carrying full diagnostic context — the
 * literal expression, which syntax it was, the workflow + step name,
 * and the original underlying error as `cause`.
 *
 * **What happens next depends on `BLOK_MAPPER_MODE`** (read from env):
 *
 * - `"warn"` (default) — the error is caught inside the Mapper, logged
 *   via `ctx.logger.logLevel("warn", ...)` (which routes to both the
 *   console AND Studio's log viewer via `TracingLogger`), and the
 *   original expression string passes through to the node. Backward-
 *   compatible with v1 behavior + actionable diagnostics.
 *
 * - `"strict"` — the error escapes the Mapper, is re-thrown by
 *   `NodeBase.blueprintMapper`, and the step fails fast with a
 *   structured error. **Recommended for production deployments** —
 *   silent input resolution failures are a source of subtle bugs
 *   (the node receives a literal `"js/ctx.bad.path"` string instead
 *   of the resolved value, then produces wrong output downstream).
 *
 * - `"silent"` — pre-v0.3.x behavior: completely suppress the error
 *   (no log, no throw). Provided as an opt-out for tests / workflows
 *   that intentionally use undefined-tolerant resolution for optional
 *   fields. Discouraged.
 *
 * This class is a `core/shared` concern (not `core/runner`) because
 * the Mapper itself lives in shared. Consumers in any package may
 * `instanceof` check it to handle resolution failures specifically
 * (e.g., a custom trigger may want to translate it into a 400-class
 * HTTP response).
 */
export class MapperResolutionError extends Error {
	/** Always the literal string `"MapperResolutionError"`. */
	public override readonly name = "MapperResolutionError";

	/** Structured diagnostic context attached at construction time. */
	public readonly context: {
		/**
		 * The literal expression that failed, WITHOUT the surrounding
		 * syntax markers. For `js/ctx.bad.path` the value is
		 * `"ctx.bad.path"`; for `${ctx.user.name}` it is `"ctx.user.name"`.
		 */
		readonly expression: string;
		/**
		 * Which template syntax was being parsed.
		 * - `"js"`  — full-string `"js/..."` expression
		 * - `"template"` — interpolated `${...}` placeholder
		 */
		readonly syntax: "js" | "template";
		/**
		 * The workflow's `name:` field, when known. Read from
		 * `ctx.workflow_name`. Absent on hand-rolled test contexts.
		 */
		readonly workflowName?: string;
		/**
		 * The step's `id` (or v1 `name`), when known. Read from
		 * `ctx._stepInfo.name` which is set by `RunnerSteps` before
		 * each step runs. Absent during early-boot or test contexts.
		 */
		readonly stepName?: string;
		/**
		 * The original error thrown by the JS evaluator (typically a
		 * `TypeError` or `ReferenceError`). Preserved for full stack
		 * trace + downstream `instanceof` checks.
		 */
		readonly cause?: unknown;
	};

	constructor(
		message: string,
		context: {
			readonly expression: string;
			readonly syntax: "js" | "template";
			readonly workflowName?: string;
			readonly stepName?: string;
			readonly cause?: unknown;
		},
	) {
		super(message);
		this.context = context;
		// Preserve the prototype chain across Babel/TS down-compilation —
		// without this, `instanceof MapperResolutionError` fails on
		// constructors transpiled to ES5 targets.
		Object.setPrototypeOf(this, MapperResolutionError.prototype);
		// Standard `Error.cause` mirror (Node 16.9+, ES2022). Lets
		// `console.error(e)` pretty-print the underlying cause too.
		if (context.cause !== undefined) {
			(this as Error & { cause?: unknown }).cause = context.cause;
		}
	}
}
