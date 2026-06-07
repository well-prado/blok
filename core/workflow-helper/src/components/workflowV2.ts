import type { z } from "zod";
import { unwrapProxies } from "../proxy/$";
import { type V2Step, V2StepSchema } from "../types/StepOpts";
import { TriggersSchema, validateTriggerConfig } from "../types/TriggerOpts";
import type { WorkflowV2 } from "../types/WorkflowOpts";

/**
 * A streaming workflow's event vocabulary: event name → Zod schema for the
 * event's `data` payload. Consumed by `@blokjs/client` to build a typed
 * discriminated union and by `@blokjs/sse-emit-typed` to constrain emits.
 */
export type EventMap = Record<string, z.ZodTypeAny>;

/**
 * The "no declared events" default. `keyof` is `never`, so
 * `EventUnion<EmptyEventMap>` collapses to `never` — i.e. a non-streaming
 * workflow, which the client uses to pick the unary call signature.
 */
export type EmptyEventMap = Record<never, never>;

/** `z.infer<T>` for a Zod schema, or `Fallback` when `T` is not a concrete schema. */
export type InferOr<T, Fallback = unknown> = [T] extends [z.ZodTypeAny] ? z.infer<T> : Fallback;

/**
 * The typed discriminated union of a streaming workflow's events:
 * `{ type: "progress"; data: {…} } | { type: "done"; data: {…} } | …`.
 * Collapses to `never` when no events are declared.
 */
export type EventUnion<E extends EventMap> = { [K in keyof E]: { type: K; data: z.infer<E[K]> } }[keyof E];

/**
 * V2 workflow author input — strict TypeScript shape with the user-facing
 * fields the lowercase `workflow()` factory accepts. Generic over the optional
 * `input`/`output` Zod schemas and the `events` map so that `workflow()` can
 * thread their inferred types onto its return ({@link TypedWorkflow}) for the
 * typed `@blokjs/client`. All three default to permissive types, so existing
 * authors that omit them are unaffected.
 */
export interface WorkflowOpts<
	I extends z.ZodTypeAny = z.ZodTypeAny,
	O extends z.ZodTypeAny = z.ZodTypeAny,
	E extends EventMap = EmptyEventMap,
> {
	/** Workflow display name. Min 3 characters. Shown in Studio. */
	name: string;
	/** Semantic version (x.x.x). Used for trace recording and audit. */
	version: string;
	/** What this workflow does. Optional but recommended. */
	description?: string;
	/**
	 * Trigger configuration. Most workflows use a single key:
	 *   `{ http: { method: "GET" } }`
	 *   `{ cron: { schedule: "0 * * * *" } }`
	 *   `{ queue: { provider: "kafka", topic: "..." } }`
	 *
	 * See `TRIGGER_SCHEMAS` for per-kind shapes. Validated per-kind at
	 * factory time.
	 */
	trigger: Record<string, unknown>;
	/** Pipeline of steps to execute in order. At least one required. */
	steps: V2Step[];
	/**
	 * Optional Zod schema describing the workflow's input (request body).
	 * Used by the `mcp` trigger to generate the exposed tool's `inputSchema`
	 * (via zod-to-json-schema) and by `@blokjs/client` to type each call's
	 * argument. Carried verbatim on `_config.input`; not validated or
	 * serialized by the runner.
	 */
	input?: I;
	/**
	 * Optional Zod schema describing the workflow's OUTPUT (terminal response
	 * body). Consumed by the typed `@blokjs/client` to type each call's return
	 * value, and — when `BLOK_VALIDATE_WORKFLOW_OUTPUT=true` — validated against
	 * the terminal step's result. Carried verbatim on `_config.output`; not
	 * serialized by the runner.
	 */
	output?: O;
	/**
	 * Optional map of SSE event name → Zod schema for STREAMING workflows.
	 * Consumed by the typed `@blokjs/client` to type the streaming event union
	 * and by `@blokjs/sse-emit-typed` to constrain emitted events. Carried
	 * verbatim on `_config.events`; not serialized by the runner.
	 */
	events?: E;
}

/**
 * The shape returned by `workflow()`. Tagged with `_blokV2: true` so the
 * scanner / loader can detect a v2-shape default export and route it
 * through the v1→v2 normalizer cleanly. The internal `_config` field
 * mirrors the legacy v1 builder output for back-compat with code that
 * already reads `step._config.trigger` etc.
 */
export interface WorkflowV2Builder {
	readonly _blokV2: true;
	readonly _config: WorkflowV2;
	/**
	 * Serialize the wrapped workflow to a JSON string. Mirrors the
	 * `HelperResponse.toJson()` contract so v2 builders are
	 * structurally compatible with the v1 workflow registry
	 * (`Workflows` map → `LocalStorage.get` fallback).
	 */
	toJson(): string;
}

/**
 * The typed return of `workflow()`. Structurally a {@link WorkflowV2Builder}
 * (so it remains a drop-in for the registry / loader), plus a phantom
 * `__blokTypes` witness that carries the workflow's inferred input/output/event
 * types. `@blokjs/client`'s `Client<BlokApp>` mapped type `infer`s these to
 * build the typed call surface. The witness is `?optional` and NEVER assigned
 * at runtime — it exists purely at the type level.
 */
export interface TypedWorkflow<TInput = unknown, TOutput = unknown, TEvents = never> extends WorkflowV2Builder {
	readonly __blokTypes?: { input: TInput; output: TOutput; events: TEvents };
}

/**
 * Lowercase v2 workflow factory. Validates inputs against the v2 schema,
 * compiles any `$` proxy expressions inside step `inputs` into
 * `"js/ctx..."` strings at definition time, and returns a tagged object
 * the runner's normalizer recognizes.
 *
 * Differences from the legacy `Workflow()` (capital W):
 * - **No chaining.** The full workflow is a single object literal —
 *   exactly what JSON workflows look like.
 * - **No separate `nodes{}` map.** `inputs` lives on each step.
 * - **Default-store** — every step's output auto-stores in `ctx.state`.
 *   Opt out with `ephemeral: true`. Multi-output: `spread: true`. Rename:
 *   `as: "<name>"`.
 * - **`branch({when, then, else})`** replaces `addCondition + AddIf + AddElse`.
 * - **`$` proxy** replaces hand-written `js/ctx....` strings with typed
 *   property access.
 *
 * @example
 *   import { workflow, branch, $ } from "@blokjs/helper";
 *
 *   export default workflow({
 *     name: "World Countries",
 *     version: "1.0.0",
 *     trigger: { http: { method: "GET" } },
 *     steps: [
 *       { id: "fetch", use: "@blokjs/api-call",
 *         inputs: { url: "https://countriesnow.space/api/v0.1/countries" } },
 *       branch({
 *         id: "route",
 *         when: $.req.query.kind,
 *         then: [{ id: "respond", use: "@blokjs/respond",
 *                  inputs: { body: $.state.fetch } }],
 *         else: [{ id: "fallback", use: "@blokjs/api-call",
 *                  inputs: { url: "https://catfact.ninja/fact" } }]
 *       })
 *     ]
 *   });
 */
export function workflow<
	I extends z.ZodTypeAny = z.ZodTypeAny,
	O extends z.ZodTypeAny = z.ZodTypeAny,
	E extends EventMap = EmptyEventMap,
>(opts: WorkflowOpts<I, O, E>): TypedWorkflow<InferOr<I>, InferOr<O>, EventUnion<E>> {
	if (!opts || typeof opts !== "object") {
		throw new Error("workflow() requires an options object.");
	}

	// Compile $ proxy expressions into js/ strings BEFORE schema validation
	// (the schema sees only strings; proxies would fail z.string().min(1)).
	const compiledSteps = unwrapProxies(opts.steps) as V2Step[];

	// Per-step schema check — surface authoring errors loudly.
	for (let i = 0; i < compiledSteps.length; i++) {
		const parsed = V2StepSchema.safeParse(compiledSteps[i]);
		if (!parsed.success) {
			const id =
				(compiledSteps[i] as { id?: string })?.id ?? (compiledSteps[i] as { name?: string })?.name ?? `<step ${i}>`;
			throw new Error(`workflow("${opts.name}") step "${id}" failed validation: ${parsed.error.message}`);
		}
	}

	// Per-kind trigger validation. Mirrors what `Trigger.addTrigger` does
	// in the v1 builder so v2 authors get the same error messages.
	const triggerKeys = Object.keys(opts.trigger ?? {});
	if (triggerKeys.length === 0) {
		throw new Error(`workflow("${opts.name}") requires a trigger.`);
	}
	const validatedTrigger: Record<string, unknown> = {};
	for (const kind of triggerKeys) {
		const parsedKind = TriggersSchema.safeParse(kind);
		if (!parsedKind.success) {
			throw new Error(
				`workflow("${opts.name}") trigger kind "${kind}" is not recognized. Allowed: http, queue, pubsub, worker, cron, webhook, sse, websocket, mcp, grpc, manual.`,
			);
		}
		validatedTrigger[kind] = validateTriggerConfig(parsedKind.data, (opts.trigger as Record<string, unknown>)[kind]);
	}

	const _config: WorkflowV2 = {
		name: opts.name,
		version: opts.version,
		description: opts.description,
		trigger: validatedTrigger,
		steps: compiledSteps,
		// Carry the optional Zod input/output schemas + event vocabulary verbatim
		// (authoring metadata for the `mcp` trigger + the typed `@blokjs/client`).
		// Excluded from toJson() — Zod schemas aren't serializable.
		...(opts.input !== undefined ? { input: opts.input } : {}),
		...(opts.output !== undefined ? { output: opts.output } : {}),
		...(opts.events !== undefined ? { events: opts.events } : {}),
	};

	return Object.freeze({
		_blokV2: true as const,
		_config,
		// `input`/`output`/`events` (Zod schemas) are authoring metadata, not part
		// of the serialized workflow — strip them so JSON consumers see a clean
		// envelope.
		toJson: () => JSON.stringify({ ..._config, input: undefined, output: undefined, events: undefined }),
		// The frozen object has no `__blokTypes` at runtime — it's a phantom
		// type witness only. Cast to attach the inferred I/O/event types so the
		// typed client can read them off `typeof <workflow>`.
	}) as TypedWorkflow<InferOr<I>, InferOr<O>, EventUnion<E>>;
}
