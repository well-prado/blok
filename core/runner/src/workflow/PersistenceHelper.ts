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
	/**
	 * Legacy v1 flag. `false` is interpreted as `ephemeral: true`. `true`
	 * is a no-op (the new default already persists).
	 */
	readonly set_var?: boolean;
}

/**
 * The shape of an execution result the helper needs to read. Both
 * `ResponseContext` and `ExecutionResult` carry `.data`.
 */
export interface PersistableResult {
	readonly data?: unknown;
	readonly success?: boolean;
}

/**
 * Apply a step's output to `ctx.state` according to the step's persistence
 * knobs.
 *
 * **Rules** (in order):
 * 1. `ephemeral: true` → no-op. Output is only available via `ctx.prev`.
 * 2. Legacy `set_var: false` → treated as `ephemeral: true` (back-compat).
 * 3. `spread: true` AND `data` is a plain object → shallow-merge data's
 *    top-level keys into `ctx.state`.
 * 4. Default → `ctx.state[as ?? name] = data`.
 *
 * Mutates `ctx.state` in place. Always safe to call (no-op on missing data
 * unless `spread` is set, which is an authoring-time error to combine with
 * non-object output and is detected at workflow load time, not here).
 */
export function applyStepOutput(ctx: Context, step: PersistableStep, result: PersistableResult): void {
	// Rule 1 & 2 — opt-out paths
	if (step.ephemeral === true) return;
	if (step.set_var === false) return;

	// Defensive: ensure state exists (TriggerBase initializes it, but
	// some legacy code paths construct ctx by hand).
	if (!ctx.state || typeof ctx.state !== "object") {
		(ctx as { state: Record<string, unknown> }).state = {};
	}

	const state = ctx.state as Record<string, unknown>;
	const data = result?.data;

	// Rule 3 — spread
	if (step.spread === true) {
		if (isPlainObject(data)) {
			Object.assign(state, data);
		}
		// Non-object data with `spread: true` is silently ignored at
		// runtime. The workflow normalizer warns at load time so the
		// author is aware.
		return;
	}

	// Rule 4 — default-store
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
