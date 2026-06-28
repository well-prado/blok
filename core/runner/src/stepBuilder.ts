/**
 * The handle-DSL authoring runtime (issue #421) — typed `step()`, the
 * callback-style `workflow()` overload, the `{$ref}`-recording handle Proxy,
 * and the `AsyncLocalStorage` builder stack from ADR 0003.
 *
 * This lives in `core/runner` (NOT `core/workflow-helper`) because `step()`
 * references a node's TS type + `Handle<OutputOf<node>>` from `./handles`, and
 * runner depends on helper — helper cannot depend on runner. This module is the
 * eventual `@blokjs/core` authoring surface; the package merge (#374) is a
 * separate task. For now these are exported from runner's public index.
 *
 * Layering: at runtime the callback `workflow()` collects the registered step
 * records (with handles lowered to structural `{$ref}` in `inputs`) and hands
 * them to the EXISTING object-style `workflow()` factory from `@blokjs/helper`,
 * so it produces the byte-identical v2 IR envelope the runner already executes.
 * The `{$ref}` sentinels flow through normalize + `lowerRefs` (ADR 0001) at
 * load time, turning into the `js/ctx.state...` wire strings the Mapper resolves.
 *
 * SCOPE (this task): linear `step()` chains + the builder stack + IR emission.
 * `branch()`/`forEach()` handle-ARM integration and `tpl` are SEPARATE follow-ups
 * (#418/#425/#329). The builder stack and `canRead` ancestry check below already
 * model child scopes so those follow-ups can push child builders without redesign.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	type EmptyEventMap,
	type EventMap,
	type EventUnion,
	type InferOr,
	type TypedWorkflow,
	type WorkflowV2Opts as WorkflowOpts,
	workflow as objectWorkflow,
} from "@blokjs/helper";
import type { z } from "zod";
import type { Handle, OutputOf } from "./handles";

/** The structural handle reference sentinel — mirrors `@blokjs/shared`'s `StructuralRef`. */
interface StructuralRef {
	$ref: { step: string; path: (string | number)[] };
}

/** Detect a handle Proxy when walking step inputs. Private — never user-visible. */
const HANDLE_META = Symbol("blok.handleMeta");

/** What a handle Proxy carries: its root step id, owning builder, and accumulated path. */
interface HandleMeta {
	step: string;
	owner: Builder;
	path: (string | number)[];
}

/** A collected step record. Mirrors the v2 step shape the object factory accepts. */
interface StepRecord {
	id: string;
	use: string;
	inputs?: Record<string, unknown>;
	[opt: string]: unknown;
}

/** A builder scope. The root carries the flat per-workflow id set (ADR 0003). */
interface Builder {
	parent?: Builder;
	root: RootBuilder;
	steps: StepRecord[];
}
interface RootBuilder extends Builder {
	ids: Set<string>;
}

/** ADR 0003: the builder stack survives `await` and isolates concurrent compiles. */
const builders = new AsyncLocalStorage<{ stack: Builder[] }>();

function currentBuilder(): Builder {
	const stack = builders.getStore()?.stack;
	const builder = stack?.[stack.length - 1];
	if (!builder) {
		throw new Error(
			"step() must be called inside workflow(name, opts, (req) => { ... }). " +
				"Called outside any workflow callback (or after the callback returned).",
		);
	}
	return builder;
}

/**
 * Is the handle's owning scope an ancestor-or-self of the reading scope?
 * (ADR 0003 cross-arm rule.)
 *
 * ponytail: wired for the branch/forEach follow-up (#418/#425). In THIS
 * linear-only PR `step()` never pushes a child builder, so every reader shares
 * the single root scope and this can never return false — the cross-arm
 * rejection in `lowerHandles` is unreachable here. Do NOT claim it as a working
 * linear guarantee; it activates only once a control-flow primitive pushes a
 * child builder. No public seam pushes a child scope today, so there is no
 * way to exercise the false branch from a linear-only test — it ships dormant.
 */
function canRead(owner: Builder, reader: Builder): boolean {
	for (let cursor: Builder | undefined = reader; cursor; cursor = cursor.parent) {
		if (cursor === owner) return true;
	}
	return false;
}

const IDENT_OR_NUM = /^\d+$/;

/**
 * Build a handle Proxy rooted at `rootKey`, owned by `owner`, with the given
 * accumulated `path`. Property/index access lengthens the path (numeric index →
 * number segment, string key → string segment) and is detectable at
 * serialization via the private {@link HANDLE_META} symbol. Banned array members
 * (`.map`/`.length`) are a TYPE concern (handles.ts enforces) — at runtime we
 * just keep accumulating.
 *
 * `makeHandle(rootKey)` is the public seam: it mints a handle rooted at a step id
 * (or `@trigger` for the callback's `req` payload) with no owner-scope constraint.
 */
function buildHandle(rootKey: string, owner: Builder | undefined, path: (string | number)[]): unknown {
	// Function target so a stray `typeof handle === "function"` check is harmless;
	// it is never called.
	return new Proxy(() => undefined, {
		get(_t, key) {
			if (key === HANDLE_META) return { step: rootKey, owner, path } satisfies Partial<HandleMeta> as HandleMeta;
			// Don't masquerade as a thenable — Promise.resolve()/await probes `.then`.
			if (key === "then") return undefined;
			if (typeof key === "symbol") return undefined;
			const k = String(key);
			const seg = IDENT_OR_NUM.test(k) ? Number(k) : k;
			return buildHandle(rootKey, owner, [...path, seg]);
		},
	});
}

/**
 * Mint a handle rooted at `rootKey` with no scope constraint. Used for the
 * trigger payload handle (`@trigger`) the callback receives. `step()` mints its
 * own owner-scoped handles internally.
 */
export function makeHandle<T = unknown>(rootKey: string): Handle<T> {
	return buildHandle(rootKey, undefined, []) as Handle<T>;
}

function readHandleMeta(value: unknown): HandleMeta | undefined {
	if (typeof value !== "function") return undefined;
	const meta = (value as { [HANDLE_META]?: HandleMeta })[HANDLE_META];
	return meta && typeof meta.step === "string" ? meta : undefined;
}

/**
 * Walk `inputs`, replacing every handle with its structural `{$ref}`. Rejects a
 * handle whose owning scope is not an ancestor-or-self of the current scope
 * (ADR 0003 cross-arm rule). Pure — returns a new value, never mutates input.
 * Plain objects/arrays are recursed; everything else passes through.
 */
function lowerHandles(value: unknown, reader: Builder): unknown {
	const meta = readHandleMeta(value);
	if (meta) {
		// `@trigger` and other unowned handles have no scope constraint.
		if (meta.owner && !canRead(meta.owner, reader)) {
			throw new Error(
				`Handle from step "${meta.step}" is read outside its scope. A handle produced inside one control-flow arm is not readable from a sibling arm or after the flow step — return a value from the flow step, or write both arms to a shared \`as\` key.`,
			);
		}
		return { $ref: { step: meta.step, path: meta.path } } satisfies StructuralRef;
	}
	if (Array.isArray(value)) return value.map((item) => lowerHandles(item, reader));
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value)) out[k] = lowerHandles((value as Record<string, unknown>)[k], reader);
		return out;
	}
	return value;
}

/** Per-step persistence/control knobs carried verbatim onto the step record. */
export interface StepOptions {
	/** Store the output at `state[as]` instead of `state[id]`. Mutually exclusive with `spread`. */
	as?: string;
	/** Shallow-merge `result.data` keys into `state`. Mutually exclusive with `as`. */
	spread?: boolean;
	/** Skip persistence; only `ctx.prev` carries the result to the next step. */
	ephemeral?: boolean;
	/** Node type override (module/local/runtime.*). Inferred from `use` when omitted. */
	type?: string;
	/** Escape hatch for the other v2 step knobs (idempotencyKey, retry, maxDuration, …). */
	[opt: string]: unknown;
}

/**
 * Register a step into the current builder and return a typed handle to its
 * output. `node` is a value produced by `defineNode`/`runtimeNode` (it carries
 * the witnessed input/output types via `./handles`); only its `name` is read at
 * runtime. `inputs` may contain handles (from earlier `step()` calls or the
 * trigger `req`), which are lowered to `{$ref}` here.
 *
 * Throws if called outside a `workflow(..., callback)`, if `id` is empty, or if
 * `id` duplicates another step id anywhere in the workflow (flat id set, ADR 0003).
 */
export function step<N extends { name: string }>(
	id: string,
	node: N,
	inputs?: Record<string, unknown>,
	opts?: StepOptions,
): Handle<OutputOf<N>> {
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("step() requires a non-empty string id.");
	}
	if (!node || typeof node.name !== "string" || node.name.length === 0) {
		throw new Error(`step("${id}") requires a node value with a name (from defineNode/runtimeNode).`);
	}
	const builder = currentBuilder();
	const ids = builder.root.ids;
	if (ids.has(id)) {
		throw new Error(`Duplicate step id "${id}". Step ids are flat per workflow — every step needs a unique id.`);
	}
	ids.add(id);

	const record: StepRecord = {
		id,
		use: node.name,
		...(inputs ? { inputs: lowerHandles(inputs, builder) as Record<string, unknown> } : {}),
		...(opts ?? {}),
	};
	builder.steps.push(record);
	return buildHandle(id, builder, []) as Handle<OutputOf<N>>;
}

/**
 * The trigger-payload handle the callback receives. Rooted at the `@trigger`
 * pseudo-step (lowerRefs maps it to `ctx.request`, where the runner puts the
 * trigger payload — NOT `ctx.state`). For request-shaped
 * triggers, author reads `req.body.x`, `req.params.id`, etc. Typed loosely for
 * now; ADR 0006 wires the per-trigger input type in a follow-up.
 */
export type TriggerHandle = Handle<unknown> & Record<string, Handle<unknown>>;

/**
 * Callback-style `workflow()` overload. Runs `build` inside a fresh builder
 * context, collects the steps the callback registered via `step()`, and emits
 * the SAME v2 IR envelope the object-style `workflow()` produces (by delegating
 * to it), with step `inputs` carrying structural `{$ref}`.
 *
 * `entry` is the typed trigger-payload handle (e.g. `req`). The callback may be
 * sync or async (`await` inside is safe — AsyncLocalStorage preserves the
 * builder across the await, ADR 0003).
 *
 * The existing object-style `workflow({...})` is UNAFFECTED — this is purely an
 * additive overload, re-exported alongside it.
 */
export async function workflowCallback<
	I extends z.ZodTypeAny = z.ZodTypeAny,
	O extends z.ZodTypeAny = z.ZodTypeAny,
	E extends EventMap = EmptyEventMap,
>(
	name: string,
	opts: Omit<WorkflowOpts<I, O, E>, "name" | "steps">,
	build: (req: TriggerHandle) => unknown | Promise<unknown>,
): Promise<TypedWorkflow<InferOr<I>, InferOr<O>, EventUnion<E>>> {
	const root: RootBuilder = { steps: [], ids: new Set<string>() } as unknown as RootBuilder;
	root.root = root;

	await builders.run({ stack: [root] }, async () => {
		// `@trigger` MUST match `lowerRefs`'s TRIGGER_SENTINEL — a ref rooted here
		// lowers to `js/ctx.request` (the trigger payload), NOT `ctx.state[...]`.
		await build(makeHandle("@trigger") as TriggerHandle);
	});

	// Delegate to the object factory so validation + envelope shape are identical.
	// The `{$ref}` sentinels are plain objects: they pass V2RegularStepSchema's
	// `inputs: z.record(z.unknown())` and survive `unwrapProxies` untouched.
	return objectWorkflow<I, O, E>({
		...(opts as WorkflowOpts<I, O, E>),
		name,
		steps: root.steps as unknown as WorkflowOpts<I, O, E>["steps"],
	});
}
