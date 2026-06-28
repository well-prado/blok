import { MapperResolutionError } from "./MapperResolutionError";

/**
 * Thrown when a `js/ctx.state.<id>...` (or `${ctx.state.<id>...}`) input
 * expression fails because the referenced state slot `ctx.state.<id>`
 * was never persisted — a dangling cross-step reference.
 *
 * This is the runtime backstop for the auto-persist-all / typed-handle
 * contract: it catches references the type system can't (raw `js/`
 * strings, stale cross-runtime stubs, hand-authored JSON twins) and
 * NAMES the missing state id and the referencing step/workflow, instead
 * of leaving a generic `Cannot read properties of undefined (reading
 * 'X')` that blames the consuming step's expression opaquely.
 *
 * A slot counts as missing ONLY when the id is absent from `ctx.state`
 * entirely (never persisted: typo'd id, ephemeral step, wrong
 * `as`/`spread`, a step that ran but errored, or a forEach body reading
 * `state[as]` before the loop populated it). A slot that EXISTS but
 * holds a falsy value (`0`, `false`, `""`, `null`) is NOT missing and
 * still resolves — only the state ROOT key is checked, never nested
 * fields, so a legitimately-undefined optional output never trips this.
 *
 * Subclass of {@link MapperResolutionError} so existing
 * `instanceof MapperResolutionError` handlers and `BLOK_MAPPER_MODE`
 * routing keep working unchanged; new code can `instanceof
 * NamedMissingStateError` to special-case the dangling-ref case.
 */
export class NamedMissingStateError extends MapperResolutionError {
	public override readonly name: string = "NamedMissingStateError";

	/** The state id (`ctx.state.<id>`) that was referenced but never persisted. */
	public readonly missingStateId: string;

	constructor(
		message: string,
		missingStateId: string,
		context: {
			readonly expression: string;
			readonly syntax: "js" | "template";
			readonly workflowName?: string;
			readonly stepName?: string;
			readonly cause?: unknown;
		},
	) {
		super(message, context);
		this.missingStateId = missingStateId;
		// Preserve the prototype chain across down-compilation so
		// `instanceof NamedMissingStateError` holds on ES5 targets.
		Object.setPrototypeOf(this, NamedMissingStateError.prototype);
	}
}
