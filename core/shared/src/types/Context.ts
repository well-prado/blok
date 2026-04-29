import type GlobalLogger from "../GlobalLogger";
import type ConfigContext from "./ConfigContext";
import type EnvContext from "./EnvContext";
import type ErrorContext from "./ErrorContext";
import type FunctionContext from "./FunctionContext";
import type LoggerContext from "./LoggerContext";
import type RequestContext from "./RequestContext";
import type ResponseContext from "./ResponseContext";
import type StateContext from "./StateContext";
import type VarsContext from "./VarsContext";

/**
 * The runtime context for a single workflow execution. One Context object
 * is created per run and threaded through every step.
 *
 * **The two-tier read model:**
 *
 * - `ctx.prev` — the previous step's full result envelope ({ data, success,
 *   error }). Overwritten on every step. Use for adjacent-step access.
 *   Aliased by `ctx.response` for back-compat with v1.
 *
 * - `ctx.state[stepId]` — each step's `result.data` is automatically
 *   persisted here under the step's `id` (or its `as` override). Use
 *   for any-distance access. Aliased by `ctx.vars` for back-compat.
 *
 * **Side-channel publication:**
 *
 * - `ctx.publish(name, value)` — explicitly publish a value into state
 *   from inside a node. Logged in Studio's trace tab. Use sparingly —
 *   most nodes should just `return` their output and let the runner
 *   persist it.
 *
 * **Request envelope aliases:**
 *
 * - `ctx.req` — alias for `ctx.request`. Read query, body, params,
 *   headers, etc. via either form.
 */
type Context = {
	id: string;
	workflow_name?: string;
	workflow_path?: string;

	/**
	 * Request envelope. Body, query, params, headers, etc.
	 *
	 * Also accessible as `ctx.req` (alias).
	 */
	request: RequestContext;

	/**
	 * Alias for `ctx.request` — same object, read-only getter. v2
	 * authoring uses `req`; v1 authoring used `request`. Both work.
	 */
	readonly req?: RequestContext;

	/**
	 * Previous step's full result envelope. **Overwritten every step.**
	 * Use for adjacent-step access only; for cross-step access use
	 * `ctx.state[stepId]`.
	 *
	 * Aliased by `ctx.response` for v1 back-compat.
	 */
	response: ResponseContext;

	/**
	 * Alias for `ctx.response` — same object. v2 authoring uses `prev`;
	 * v1 authoring used `response.data`. Both work.
	 */
	readonly prev?: ResponseContext;

	error: ErrorContext;
	logger: LoggerContext;
	config: ConfigContext;
	func?: FunctionContext;

	/**
	 * Accumulated step outputs by step `id`. Filled automatically when
	 * a step completes (unless `ephemeral: true`).
	 *
	 * Aliased by `ctx.vars` for v1 back-compat — both fields point at
	 * the same underlying object.
	 *
	 * Always initialized to `{}` by `TriggerBase.createContext`. Marked
	 * optional only so legacy code paths that hand-construct a Context
	 * (some tests, internal utilities) keep type-checking; production
	 * runs always have `state` defined.
	 */
	state?: StateContext;

	/**
	 * Alias for `ctx.state` — same underlying object. v2 authoring
	 * uses `state`; v1 authoring used `vars`. Both work.
	 *
	 * @deprecated Prefer `ctx.state` (or `$.state.<id>` from inputs).
	 */
	vars?: VarsContext;

	env?: EnvContext;
	eventLogger: GlobalLogger | unknown;

	/**
	 * Explicit side-channel publication. Writes to state under `name`
	 * and emits a Studio trace event. Use only when a node needs to
	 * publish something other than its return value (most nodes don't).
	 */
	publish?: (name: string, value: unknown) => void;

	_PRIVATE_: unknown;
};

export default Context;
