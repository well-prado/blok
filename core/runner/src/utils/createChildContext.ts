import type { Context, LoggerContext } from "@blokjs/shared";
import { v4 as uuid } from "uuid";

/**
 * Construct a fresh `Context` for a sub-workflow invocation.
 *
 * **Isolation contract**: the child gets fresh `state`, fresh `response`,
 * fresh `error`, and a fresh `id`. The child cannot read or mutate the
 * parent's state — sub-workflows are referentially transparent at the
 * state-passing boundary. Parent passes data in via `request.body`
 * (mirrors HTTP semantics), child returns data via `ctx.response`.
 *
 * **Shared by reference (intentional)**: the `logger`, `env`, and
 * `eventLogger` are shared with the parent — log routing stays
 * consistent and ENV is process-global anyway. The runner's tracing
 * layer (`_traceRunId`, `_traceNodeId`) is set separately by
 * `SubworkflowNode` after this function returns.
 *
 * Mirrors `TriggerBase.createContext` shape one-for-one (same `req`/
 * `prev` getters, same `state`/`vars` aliasing, same `publish`
 * default). Kept as a standalone helper rather than a TriggerBase
 * method so sub-workflow dispatch doesn't depend on having a
 * TriggerBase instance.
 */
export function createChildContext(
	parent: Context,
	opts: {
		/** The child workflow's `name:` field. */
		workflowName: string;
		/** Filesystem path or `"<inline>"` — used for trace + diagnostics. */
		workflowPath: string;
		/** Parent step's resolved inputs, becomes child's `request.body`. */
		body: unknown;
		/** Child's resolved `nodes` map (from child Configuration). Powers blueprint mapper. */
		config: Context["config"];
	},
): Context {
	const id = uuid();
	const request: Context["request"] = {
		body: (opts.body as Context["request"]["body"]) ?? {},
		headers: {} as Context["request"]["headers"],
		params: {} as Context["request"]["params"],
		query: {} as Context["request"]["query"],
	} as Context["request"];
	const response: Context["response"] = {
		data: "",
		contentType: "",
		success: true,
		error: null,
	} as Context["response"];
	const state: Record<string, unknown> = {};

	// Tier 2 follow-up · cooperative cancellation. Child gets its own
	// AbortController so it has independent lifecycle (cancellation of
	// THIS sub-workflow doesn't propagate up to the parent). But we
	// chain off the parent's signal: if the parent gets cancelled, the
	// child should abort too — otherwise long-running sub-workflows
	// would orphan when the parent exits.
	const childAbortController = new AbortController();
	if (parent.signal) {
		if (parent.signal.aborted) {
			childAbortController.abort();
		} else {
			parent.signal.addEventListener(
				"abort",
				() => {
					if (!childAbortController.signal.aborted) childAbortController.abort();
				},
				{ once: true },
			);
		}
	}

	const ctx: Context = {
		id,
		workflow_name: opts.workflowName,
		workflow_path: opts.workflowPath,
		config: opts.config,
		request,
		response,
		error: { message: [] } as Context["error"],
		logger: parent.logger as LoggerContext,
		eventLogger: parent.eventLogger ?? null,
		// Fresh state map — child runs in isolation. Aliased as `vars`
		// for v1 back-compat, same shape as `TriggerBase.createContext`.
		state,
		vars: state,
		env: parent.env,
		signal: childAbortController.signal,
		// Stash the controller in a child-specific _PRIVATE_ slot so the
		// tracker can fire it via abortRunningRun on direct sub-run cancel.
		// Don't mutate the parent's _PRIVATE_ (intentional isolation).
		_PRIVATE_: { abortController: childAbortController },
	};

	// V2 read-only aliases — same object reference, no copy. Mirrors
	// `TriggerBase.createContext`.
	Object.defineProperty(ctx, "req", {
		get() {
			return ctx.request;
		},
		enumerable: true,
	});
	Object.defineProperty(ctx, "prev", {
		get() {
			return ctx.response;
		},
		enumerable: true,
	});

	// Default `publish` — writes to state, no side-channel event. The
	// triggers' production createContext also wires Studio trace
	// events; for sub-workflows we omit that (the child has its own
	// trace run, events fire there).
	ctx.publish = (name: string, value: unknown): void => {
		(ctx.state as Record<string, unknown>)[name] = value;
	};

	return ctx;
}
