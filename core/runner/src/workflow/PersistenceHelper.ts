import type { Context } from "@blokjs/shared";

/**
 * The shape of a step instance the helper needs to make a persistence
 * decision. Both `BlokService` and `RuntimeAdapterNode` satisfy this.
 *
 * Read-only — the helper never mutates the step.
 */
export interface PersistableStep {
	/** Step's stable identifier (today's `name` field on NodeBase). */
	readonly name: string;
	/** Optional alias — store at `state[as]` instead of `state[name]`. */
	readonly as?: string;
	/** When true, shallow-merge result.data keys into state. */
	readonly spread?: boolean;
	/** When true, skip persistence entirely. */
	readonly ephemeral?: boolean;
}

/**
 * The shape of an execution result the helper needs to read. Both
 * `ResponseContext` and `ExecutionResult` carry `.data`. Errors arrive
 * via different field names depending on the source — `error` on
 * `ResponseContext` / `BlokResponse`, `errors` on `ExecutionResult` from
 * the runtime adapters. Both shapes are accepted and trigger the same
 * "skip persistence" guard.
 */
export interface PersistableResult {
	readonly data?: unknown;
	readonly success?: boolean;
	readonly error?: unknown;
	readonly errors?: unknown;
}

/**
 * Apply a step's output to `ctx.state` according to the step's persistence
 * knobs.
 *
 * **Rules** (evaluated in order):
 * 0. **Errored result → no-op.** A step that threw, returned `success:
 *    false`, or carries a non-null `error` / `errors` field does NOT write
 *    state. Authors can rely on `ctx.state[<step-id>] === undefined` as a
 *    truthful "did this step actually succeed?" check inside a
 *    `tryCatch.catch` arm. Without this guard, the framework's internal
 *    `BlokResponse.setError()` writes `data = {}` and the helper would
 *    persist that empty object — making the natural existence check
 *    meaningless. (See [tryCatch docs](../../../docs/c/devtools/tryCatch.mdx).)
 * 1. `ephemeral: true` → no-op. Output is only available via `ctx.prev`.
 * 2. `spread: true` AND `data` is a plain object → shallow-merge data's
 *    top-level keys into `ctx.state`.
 * 3. Default → `ctx.state[as ?? name] = data`.
 *
 * Mutates `ctx.state` in place. Always safe to call (no-op on missing data
 * unless `spread` is set, which is an authoring-time error to combine with
 * non-object output and is detected at workflow load time, not here).
 */
export function applyStepOutput(ctx: Context, step: PersistableStep, result: PersistableResult): void {
	// Rule 0 — error guard. Centralized so all callers (Blok.run,
	// RuntimeAdapterNode.run, SubworkflowNode.dispatchSync) inherit the
	// same truthful-state contract without each re-implementing the check.
	if (isErroredResult(result)) return;

	// Rule 1 — opt-out path
	if (step.ephemeral === true) return;

	// Defensive: ensure state exists (TriggerBase initializes it, but
	// some legacy code paths construct ctx by hand).
	if (!ctx.state || typeof ctx.state !== "object") {
		(ctx as { state: Record<string, unknown> }).state = {};
	}

	const state = ctx.state as Record<string, unknown>;
	const data = result?.data;

	// Rule 2 — spread
	if (step.spread === true) {
		if (isPlainObject(data)) {
			Object.assign(state, data);
		}
		// Non-object data with `spread: true` is silently ignored at
		// runtime. The workflow normalizer warns at load time so the
		// author is aware.
		return;
	}

	// Rule 3 — default-store
	if (data === undefined) return;
	const key = step.as ?? step.name;
	if (!key) return; // defensive: anonymous step (shouldn't happen post-normalizer)
	state[key] = data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || value === undefined) return false;
	if (typeof value !== "object") return false;
	if (Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

/**
 * Detect whether a step result represents a failure. Three indicators —
 * `success: false`, a non-null `error` (ResponseContext / BlokResponse
 * shape), or a non-null `errors` (ExecutionResult shape from the runtime
 * adapters) — are all treated equivalently. Any one is enough to skip
 * persistence so the next step's `ctx.state[<id>]` check tells the truth.
 */
function isErroredResult(result: PersistableResult): boolean {
	if (result.success === false) return true;
	if (result.error !== undefined && result.error !== null) return true;
	if (result.errors !== undefined && result.errors !== null) return true;
	return false;
}
