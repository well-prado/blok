import type { CapabilityAuthority, Context, InteractionAttribution, LoggerContext } from "@blokjs/shared";
import { v4 as uuid } from "uuid";
import { propagatePolicyExecution } from "../policy/PolicyPipeline";

export interface ExecutionBudget {
	readonly maxDurationMs?: number;
	readonly maxMemoryBytes?: number;
	readonly maxInputBytes?: number;
	readonly maxOutputBytes?: number;
	readonly maxConcurrency?: number;
}

export interface ExecutionScope {
	readonly abortController: AbortController;
	readonly listenerCleanup: AbortController;
	readonly authority?: CapabilityAuthority;
	readonly budget?: ExecutionBudget;
	readonly lineage?: InteractionAttribution;
}

/** Build bounded, deterministic lineage for a nested scope. */
export function deriveNestedAttribution(
	parent: Context,
	segment: string,
	options?: { branchId?: string; branchIndex?: number },
): InteractionAttribution {
	const parentPrivate = parent._PRIVATE_ as { lineage?: InteractionAttribution } | null;
	const inherited = parentPrivate?.lineage;
	const parentRunId = (parent as Record<string, unknown>)._traceRunId;
	const parentId = typeof parentRunId === "string" ? parentRunId : parent.id;
	const rootId = inherited?.rootId ?? parentId;
	const branchPath = [...(inherited?.branchPath ?? []), segment].slice(-32);
	return {
		rootId,
		parentId,
		...(options?.branchId ? { branchId: options.branchId } : {}),
		...(options?.branchIndex !== undefined ? { branchIndex: options.branchIndex } : {}),
		branchPath,
		depth: (inherited?.depth ?? 0) + 1,
	};
}

function attachCancellation(parent: Context, child: Context, scope: ExecutionScope): void {
	if (parent.signal) {
		if (parent.signal.aborted) scope.abortController.abort();
		else
			parent.signal.addEventListener(
				"abort",
				() => {
					if (!scope.abortController.signal.aborted) scope.abortController.abort();
				},
				{ once: true, signal: scope.listenerCleanup.signal },
			);
	}
	(child as { signal: AbortSignal }).signal = scope.abortController.signal;
	(child as { _PRIVATE_: unknown })._PRIVATE_ = scope;
}

/** Create an isolated cancellation/metadata scope for a parallel branch. */
export function createScopedExecutionContext(
	parent: Context,
	child: Context,
	opts?: {
		childAuthority?: CapabilityAuthority;
		budget?: ExecutionBudget;
		attribution?: InteractionAttribution;
	},
): Context {
	const scope: ExecutionScope = {
		abortController: new AbortController(),
		listenerCleanup: new AbortController(),
		...(opts?.childAuthority ? { authority: opts.childAuthority } : {}),
		...(opts?.budget ? { budget: { ...opts.budget } } : {}),
		...(opts?.attribution ? { lineage: opts.attribution } : {}),
	};
	attachCancellation(parent, child, scope);
	propagatePolicyExecution(parent, child, opts?.childAuthority, opts?.attribution);
	return child;
}

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
		/** Validated child authority, narrowed from the parent's policy state. */
		childAuthority?: CapabilityAuthority;
		budget?: ExecutionBudget;
		/** Bounded audit lineage for the child scope. */
		attribution?: InteractionAttribution;
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
	//
	// PR 1 follow-up · A3 fix. `addEventListener({once: true})` only
	// auto-removes the listener when abort fires. If the parent never
	// aborts AND the parent ctx outlives many child invocations, listeners
	// accumulate and Node's MaxListenersExceededWarning fires at the 11th.
	// Pass a child-scoped AbortSignal as the listener's `signal:` option
	// so the listener auto-removes when the child completes (the
	// SubworkflowNode dispatch path calls `listenerCleanup.abort()` in
	// its finally block).
	const scope: ExecutionScope = {
		abortController: new AbortController(),
		listenerCleanup: new AbortController(),
		...(opts.childAuthority ? { authority: opts.childAuthority } : {}),
		...(opts.budget ? { budget: { ...opts.budget } } : {}),
		...(opts.attribution ? { lineage: opts.attribution } : {}),
	};

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
		signal: scope.abortController.signal,
		// Stash the controller in a child-specific _PRIVATE_ slot so the
		// tracker can fire it via abortRunningRun on direct sub-run cancel.
		// Don't mutate the parent's _PRIVATE_ (intentional isolation).
		// `listenerCleanup` is exposed so SubworkflowNode can abort it on
		// child completion, which removes the parent.signal listener (PR 1
		// A3 fix — prevents listener accumulation on long-lived parents).
		_PRIVATE_: scope,
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
	attachCancellation(parent, ctx, scope);
	propagatePolicyExecution(parent, ctx, opts.childAuthority, opts.attribution);

	return ctx;
}
