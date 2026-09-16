/**
 * `definePage()` — the typed page contract (#995, v3 shape per #1008).
 *
 * A page's props are declared ONCE, server-side, outside the workflow
 * callback. That placement is the whole point: a `page()` step inside the
 * callback cannot leak its inferred type to module scope, so the frontend has
 * nothing to import. Declaring the contract outside fixes that with no core
 * change, and gives `blokctl gen` (#998) and DevTools (#1017) one registry to
 * read.
 *
 * ```ts
 * export const OrdersIndex = definePage("Orders/Index", {
 *   auth:    always(currentUser),
 *   orders:  listOrders,
 *   filters: optional(loadFilters),
 *   stats:   defer(heavyStats, { group: "dashboard", rescue: true }),
 * });
 *
 * export default workflow("Orders page", { version: "1.0.0", trigger: http.get("/orders") }, (req) => {
 *   OrdersIndex.render(req, "page", "/orders", {
 *     auth: {}, orders: { userId: shared(currentUser, "auth").id }, filters: {}, stats: { userId: … },
 *   });
 * });
 * ```
 *
 * `render()` lowers to ONE `page` control step; the RUNNER decides per request
 * which props actually run (#1008).
 */

import { type Handle, type InputOf, type OutputOf, type Refable, makeHandle, page } from "@blokjs/core";
import type { RespondEnvelope } from "@blokjs/shared";
import type { z } from "zod";
import type { ScrollMetadata } from "./paginate.js";

// =============================================================================
// Prop-mode wrappers
// =============================================================================

/** Anything `step()` accepts: a `defineNode()` value or a `runtimeNode()` stub. */
export type NodeLike = { readonly name: string };

/** How the runner resolves a prop. `merge`/`once`/`scroll` resolve like `regular`. */
export type PropMode = "regular" | "always" | "optional" | "defer" | "merge" | "once" | "scroll";

/** Options for {@link defer}. */
export interface DeferOptions {
	/** Deferred props sharing a group are fetched by the client in one follow-up request. */
	group?: string;
	/** A throw omits the prop and lists it in `rescuedProps` instead of failing the run. */
	rescue?: boolean;
}

/**
 * One merge direction's target: the whole prop (`true`), one sub-path
 * (`"data"`), several (`["notifications","activities"]`), or a map pairing each
 * sub-path with the field to match items on (`{ "users.data": "id" }`).
 */
export type MergeTarget = boolean | string | string[] | Record<string, string>;

/** Options for {@link merge} — client-side merge strategy (#1009). */
export interface MergeOptions {
	/** What the client APPENDS to (`append: "data"` labels `<key>.data`). Default: the whole prop. */
	append?: MergeTarget;
	/** What the client PREPENDS to. `prepend: true` prepends the whole prop. */
	prepend?: MergeTarget;
	/** Sub-path (or `true` for the whole prop) the client DEEP-merges. */
	deep?: string | boolean;
	/** Item field used to match+replace merged rows instead of appending, e.g. `"id"`. */
	matchOn?: string;
}

/** Options for {@link once} — client-side one-shot caching (#1009). */
export interface OnceOptions {
	/** Cache key. Defaults to the prop key — two props sharing one key share the value. */
	as?: string;
	/** Lifetime — a duration (`"1h"`), a number of SECONDS, or an absolute date. */
	until?: string | number | Date;
	/**
	 * Resolve and resend even when the client still holds the value.
	 *
	 * A boolean, not a callback: prop metadata is workflow CONFIG, which is
	 * JSON-cloned at boot, so a function would silently vanish. Decide per
	 * request from the client instead (`router.reload({ only: ["plans"] })`
	 * always resolves), or from inside the prop's own node.
	 */
	fresh?: boolean;
}

/**
 * Options for {@link scroll} — infinite-scroll paging (#1010).
 *
 * `T` is the prop node's output type, so a `metadata` resolver is typed
 * against it. It defaults to `never` (not `unknown`) because that is what makes
 * a resolver for a CONCRETE output assignable to the erased
 * `ScrollOptions` the registry stores.
 */
export interface ScrollOptions<T = never> {
	/**
	 * Sub-path holding the page's items — the one the client GROWS. Default
	 * `"data"` (what {@link paginate} returns them under); `""` grows the whole
	 * prop.
	 */
	wrapper?: string;
	/**
	 * Query-string parameter the client bumps. Overrides the resolved
	 * metadata's own `pageName`; two scroll props on one page need distinct
	 * names so their cursors do not collide (`?users=2&orders=3`).
	 */
	pageName?: string;
	/**
	 * Map an arbitrary node output onto {@link ScrollMetadata}. Omit it when the
	 * output already carries the four fields — which is what `paginate()` /
	 * `cursorPaginate()` are for.
	 */
	metadata?: (output: T) => ScrollMetadata;
}

const PROP_BRAND = Symbol.for("blok.inertia.propMode");

/**
 * `merge` and `scroll` only describe what the CLIENT does with the value, so
 * they never take the resolution slot: `defer(merge(node, …))` is a deferred
 * prop that also carries merge labels.
 */
type MetadataMode = "merge" | "scroll";

/** The modes that decide WHETHER a prop resolves, laziest first. */
const RESOLUTION_ORDER = ["defer", "optional", "once", "always"] as const;

/** A node wrapped in a resolution mode. Opaque to authors — pass it to {@link definePage}. */
export interface ModeProp<N extends NodeLike, M extends PropMode> {
	readonly [PROP_BRAND]: M;
	readonly node: N;
	readonly options: Readonly<Record<string, unknown>>;
	/** Every wrapper in the chain, keyed by its own mode — `once(merge(n))` has both. */
	readonly modes: Readonly<Partial<Record<PropMode, Record<string, unknown>>>>;
}

/** The node behind a prop value, whether or not it is wrapped (possibly twice). */
type Unwrap<V> = V extends ModeProp<infer N, PropMode> ? N : V;
/** The mode a prop value already carries. A bare node is `"regular"`. */
type InnerMode<V> = V extends ModeProp<NodeLike, infer M> ? M : "regular";
/** Wrapping mode `O` around mode `I`: a metadata mode yields to whatever is inside. */
type Fold<I extends PropMode, O extends PropMode> = O extends MetadataMode ? (I extends "regular" ? O : I) : O;

function wrap(mode: PropMode, node: PropValue, options: Record<string, unknown> = {}): ModeProp<NodeLike, PropMode> {
	const inner = readMode(node);
	const base = (inner?.node ?? node) as NodeLike;
	if (!base || typeof base.name !== "string" || base.name.length === 0) {
		throw new Error(
			`${mode}() requires a node value (from defineNode/runtimeNode), or another mode wrapper. Fix: ${mode}(listOrders).`,
		);
	}
	const modes = { ...(inner?.modes ?? {}), [mode]: options };
	// The laziest resolution mode in the chain wins; with none, the outer
	// metadata mode stands so a plain `merge(node)` still reports mode "merge".
	const resolution =
		RESOLUTION_ORDER.find((candidate) => modes[candidate] !== undefined) ??
		(inner && inner.mode !== "regular" ? inner.mode : mode);
	return { [PROP_BRAND]: resolution, node: base, options: modes[resolution] ?? {}, modes };
}

/** Always resolved, and exempt from every partial-reload `only`/`except` filter. */
export function always<V extends PropValue>(node: V): ModeProp<Unwrap<V>, Fold<InnerMode<V>, "always">> {
	return wrap("always", node) as ModeProp<Unwrap<V>, Fold<InnerMode<V>, "always">>;
}

/** Never resolved on a full visit — only when the client asks for it by name. */
export function optional<V extends PropValue>(node: V): ModeProp<Unwrap<V>, Fold<InnerMode<V>, "optional">> {
	return wrap("optional", node) as ModeProp<Unwrap<V>, Fold<InnerMode<V>, "optional">>;
}

/** Announced on the full visit, resolved in the client's follow-up partial request. */
export function defer<V extends PropValue>(
	node: V,
	options: DeferOptions = {},
): ModeProp<Unwrap<V>, Fold<InnerMode<V>, "defer">> {
	return wrap("defer", node, { ...options }) as ModeProp<Unwrap<V>, Fold<InnerMode<V>, "defer">>;
}

/** Resolves like a regular prop; the client APPENDS/PREPENDS/deep-merges it (#1009). */
export function merge<V extends PropValue>(
	node: V,
	options: MergeOptions = {},
): ModeProp<Unwrap<V>, Fold<InnerMode<V>, "merge">> {
	return wrap("merge", node, { ...options }) as ModeProp<Unwrap<V>, Fold<InnerMode<V>, "merge">>;
}

/** Resolved once; afterwards the client replays its remembered copy and the node is skipped (#1009). */
export function once<V extends PropValue>(
	node: V,
	options: OnceOptions = {},
): ModeProp<Unwrap<V>, Fold<InnerMode<V>, "once">> {
	return wrap("once", node, { ...options }) as ModeProp<Unwrap<V>, Fold<InnerMode<V>, "once">>;
}

/** Resolves like a regular prop; the client grows it as the user scrolls (#1010). */
export function scroll<V extends PropValue>(
	node: V,
	options: ScrollOptions<OutputOf<Unwrap<V>>> = {},
): ModeProp<Unwrap<V>, Fold<InnerMode<V>, "scroll">> {
	return wrap("scroll", node, { ...options }) as ModeProp<Unwrap<V>, Fold<InnerMode<V>, "scroll">>;
}

interface ReadMode {
	mode: PropMode;
	node: NodeLike;
	options: Record<string, unknown>;
	modes: Partial<Record<PropMode, Record<string, unknown>>>;
}

function readMode(value: unknown): ReadMode | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const mode = (value as Record<symbol, unknown>)[PROP_BRAND];
	if (typeof mode !== "string") return undefined;
	const wrapped = value as unknown as ModeProp<NodeLike, PropMode>;
	return { mode: mode as PropMode, node: wrapped.node, options: wrapped.options, modes: { ...wrapped.modes } };
}

// =============================================================================
// Types
// =============================================================================

/** One declared prop: a bare node, or a node in a mode wrapper. */
export type PropValue = NodeLike | ModeProp<NodeLike, PropMode>;
/** A page's prop declaration. */
export type PageShape = Record<string, PropValue>;

/** The node behind a prop declaration, whether or not it is wrapped. */
type NodeOf<V> = V extends ModeProp<infer N, PropMode> ? N : V;
/** The mode of a prop declaration. A bare node is `"regular"`. */
type ModeOf<V> = V extends ModeProp<NodeLike, infer M> ? M : "regular";

/** Modes whose value may be absent from the page object on any given visit. */
type LazyMode = "optional" | "defer";

/**
 * A page's props as the CLIENT sees them.
 *
 * `optional` / `defer` keys are `T | undefined` — the client only receives them
 * on the visit that asked for them. Every other mode (including `once`, which
 * the client rehydrates from its own cache) is present.
 */
export type PropsOf<P extends PageShape> = {
	[K in keyof P]: ModeOf<P[K]> extends LazyMode ? OutputOf<NodeOf<P[K]>> | undefined : OutputOf<NodeOf<P[K]>>;
};

/**
 * Props of a page component: everything {@link definePage} declared, plus the
 * always-present `errors` bag (`string[]` per field under `withAllErrors`).
 */
export type PageProps<T extends { readonly __props: unknown }> = T["__props"] & {
	errors: Record<string, string | string[]>;
};

/** A node whose input type has no required field — its `render()` entry may be omitted. */
type InputOptional<N> = Record<string, never> extends InputOf<N> ? true : unknown extends InputOf<N> ? true : false;

/** The `inputs` for one prop: its node's input schema, with handles allowed anywhere. */
type PropInputs<V> = Refable<InputOf<NodeOf<V>>>;

/**
 * `render()`'s fourth argument: node inputs PER PROP. A prop whose node takes a
 * required input must appear; one that takes none may be omitted.
 */
export type RenderInputs<P extends PageShape> = {
	[K in keyof P as InputOptional<NodeOf<P[K]>> extends true ? never : K]: PropInputs<P[K]>;
} & {
	[K in keyof P as InputOptional<NodeOf<P[K]>> extends true ? K : never]?: PropInputs<P[K]>;
};

/** Page-level knobs — everything that is not a prop. */
export interface RenderOptions {
	/** Asset version. `""` (the default) means untracked. */
	version?: string | Handle<string>;
	/** Validation errors. Always emitted as `props.errors`. */
	errors?: Refable<Record<string, unknown>>;
	/**
	 * `true` ships EVERY message per field (`string[]`) instead of Inertia's
	 * default one message per field. The serializer has always accepted it;
	 * without this entry a `render()` caller could not reach it without dropping
	 * to the raw node (#1003).
	 */
	withAllErrors?: boolean;
	/** Shell-template values (`{{key}}`). NEVER sent to the client. */
	viewData?: Refable<Record<string, unknown>>;
	/** HTML shell template. Must contain `<!--blok:app-->`. */
	shell?: string;
	/** Markup injected at `<!--blok:head-->`. */
	head?: string | Handle<string>;
	/** Root element id and `data-page` attribute value. Default `"app"`. */
	rootId?: string;
	/** Encrypt this history entry client-side. */
	encryptHistory?: boolean;
	/** Clear the client's history state on this visit. */
	clearHistory?: boolean;
	/** Keep the current URL fragment across the visit. */
	preserveFragment?: boolean;
	/** Flash data. #996 owns the middleware that fills this; passed through verbatim. */
	flash?: Refable<Record<string, unknown>>;
	/** `false` hides the shared-prop key list from the page object (#1015). Values still ship. */
	exposeSharedPropKeys?: boolean;
}

/**
 * A reusable prop bundle — declare a set of props once and spread it into every
 * page that needs them, with the types intact (Laravel's
 * `ProvidesInertiaProperties`).
 *
 * ```ts
 * const dashboard = withProps({ auth: always(currentUser), nav: loadNav });
 * export const Home = definePage("Home", { ...dashboard, stats: loadStats });
 * export const Team = definePage("Team", { ...dashboard, members: loadMembers });
 * ```
 *
 * ponytail: a typed identity, on purpose. The bundle IS a `PageShape`, so the
 * spread is all the machinery a bundle needs; this only pins the type so the
 * keys stay inferred (and gives the concept a name to search for).
 */
export function withProps<B extends PageShape>(bundle: B): B {
	if (!bundle || typeof bundle !== "object") {
		throw new Error("withProps() requires a props object. Fix: withProps({ auth: always(currentUser) }).");
	}
	return { ...bundle };
}

/** What `definePage()` returns. */
export interface PageDef<P extends PageShape> {
	readonly component: string;
	readonly props: P;
	/**
	 * Phantom carrier for the prop type — never present at runtime. It is what
	 * makes `PageProps<typeof X>` and `@blokjs/inertia-client`'s `PagePropsOf`
	 * work from a plain `import type`.
	 */
	readonly __props: PropsOf<P>;
	/**
	 * Emit the `page` control step. `inputs` are NODE INPUTS per prop (handles
	 * allowed) — not resolved values: the runner decides per request which of
	 * those nodes actually run.
	 */
	render(
		req: Handle<unknown>,
		id: string,
		/**
		 * The page object's `url` — what Inertia pushes into history.
		 *
		 * `{ $tpl }` is the shape `tpl\`/orders/${req.params.id}\`` returns
		 * (`@blokjs/core` keeps `StructuralTpl` private), and it is what a
		 * PARAMETERISED route needs: without it a `/things/:id` page can only be
		 * rendered at a constant URL, which puts the wrong entry in history. The
		 * runner lowers it exactly like a handle.
		 */
		url: string | Handle<string> | { $tpl: unknown[] },
		inputs: RenderInputs<P>,
		opts?: RenderOptions,
	): Handle<RespondEnvelope>;
}

// =============================================================================
// Registry
// =============================================================================

/** One prop's entry in the registry — what codegen (#998) and DevTools (#1017) read. */
export interface PageRegistryProp {
	mode: PropMode;
	group?: string;
	rescue?: boolean;
	merge?: MergeOptions;
	once?: OnceOptions;
	scroll?: ScrollOptions;
	/** The node's Zod output schema, when it has one (a `runtimeNode` stub does not). */
	outputSchema?: z.ZodTypeAny;
	/** Where the prop was declared. Best-effort — derived from the `definePage` call site. */
	source?: { file: string; line: number };
}

export interface PageRegistryEntry {
	component: string;
	props: Record<string, PageRegistryProp>;
	source?: { file: string; line: number };
}

const registry = new Map<string, PageRegistryEntry>();

/** Every page declared in this process, keyed by component name. */
export function getPageRegistry(): ReadonlyMap<string, PageRegistryEntry> {
	return registry;
}

/** Drop every registered page. Test-only — a fresh module graph re-registers. */
export function _resetPageRegistry(): void {
	registry.clear();
}

/**
 * The `definePage(...)` call site, from the stack. Best-effort by design: the
 * value is documentation for Studio/codegen, never load-bearing, so a runtime
 * that formats stacks differently degrades to `undefined` rather than throwing.
 */
function callSite(): { file: string; line: number } | undefined {
	const stack = new Error("page-source").stack;
	if (!stack) return undefined;
	// [0] "Error: page-source", [1] callSite, [2] definePage, [3] the author's file.
	const frame = stack.split("\n")[3];
	const match = frame?.match(/\(?([^()\s]+):(\d+):\d+\)?$/);
	if (!match) return undefined;
	return { file: (match[1] as string).replace(/^file:\/\//, ""), line: Number(match[2]) };
}

/** A `defineNode()` value carries its Zod schemas; a `runtimeNode()` stub does not. */
function outputSchemaOf(node: NodeLike): z.ZodTypeAny | undefined {
	const schema = (node as { definition?: { output?: unknown } }).definition?.output;
	return schema && typeof schema === "object" && "_def" in schema ? (schema as z.ZodTypeAny) : undefined;
}

// =============================================================================
// definePage
// =============================================================================

/**
 * Declare a page's component name and its prop contract.
 *
 * @throws if `component` is already declared — two pages sharing a component
 * name would make `PageProps` and the generated client types ambiguous, and the
 * registry can only hold one.
 */
export function definePage<P extends PageShape>(component: string, shape: P): PageDef<P> {
	if (typeof component !== "string" || component.length === 0) {
		throw new Error('definePage() requires a non-empty component name. Fix: definePage("Orders/Index", { … }).');
	}
	if (!shape || typeof shape !== "object") {
		throw new Error(
			`definePage("${component}") requires a props object. Fix: definePage("${component}", { orders: listOrders }).`,
		);
	}
	const existing = registry.get(component);
	if (existing) {
		const where = existing.source ? ` (first declared at ${existing.source.file}:${existing.source.line})` : "";
		throw new Error(
			`definePage("${component}") — that component name is already declared${where}. Component names are the page identity. Fix: pick a distinct component name.`,
		);
	}

	const source = callSite();
	const entry: PageRegistryEntry = { component, props: {}, ...(source ? { source } : {}) };
	for (const key of Object.keys(shape)) {
		const declared = shape[key] as PropValue;
		const wrapped = readMode(declared);
		const node = (wrapped?.node ?? declared) as NodeLike;
		if (!node || typeof node.name !== "string" || node.name.length === 0) {
			throw new Error(
				`definePage("${component}") prop "${key}" must be a node value, or a node in a mode wrapper (always/optional/defer/merge/once/scroll). Fix: ${key}: listOrders, or ${key}: defer(listOrders).`,
			);
		}
		// Each wrapper contributes its OWN bag, so a composed prop keeps all of
		// them: `defer(merge(node, …))` is mode `defer` WITH merge labels (#1009).
		const modes = wrapped?.modes ?? {};
		const deferOptions = (modes.defer ?? {}) as DeferOptions;
		const outputSchema = outputSchemaOf(node);
		entry.props[key] = {
			mode: wrapped?.mode ?? "regular",
			...(typeof deferOptions.group === "string" ? { group: deferOptions.group } : {}),
			...(deferOptions.rescue === true ? { rescue: true } : {}),
			...(modes.merge ? { merge: modes.merge as MergeOptions } : {}),
			...(modes.once ? { once: modes.once as OnceOptions } : {}),
			...(modes.scroll ? { scroll: modes.scroll as ScrollOptions } : {}),
			...(outputSchema ? { outputSchema } : {}),
			...(source ? { source } : {}),
		};
	}
	registry.set(component, entry);

	const def: PageDef<P> = {
		component,
		props: shape,
		__props: undefined as unknown as PropsOf<P>,
		render(_req, id, url, inputs, opts) {
			const props: Record<string, Record<string, unknown>> = {};
			for (const key of Object.keys(shape)) {
				const declared = shape[key] as PropValue;
				const wrapped = readMode(declared);
				const node = (wrapped?.node ?? declared) as NodeLike;
				const meta = entry.props[key] as PageRegistryProp;
				const propInputs = (inputs as Record<string, unknown>)[key];
				props[key] = {
					node,
					...(propInputs !== undefined ? { inputs: propInputs as Record<string, unknown> } : {}),
					...(meta.mode !== "regular" ? { mode: meta.mode } : {}),
					...(meta.group !== undefined ? { group: meta.group } : {}),
					...(meta.rescue !== undefined ? { rescue: meta.rescue } : {}),
					...(meta.merge !== undefined ? { merge: meta.merge } : {}),
					...(meta.once !== undefined ? { once: meta.once } : {}),
					...(meta.scroll !== undefined ? { scroll: meta.scroll } : {}),
				};
			}
			const serializerInputs: Record<string, unknown> = {};
			for (const [field, value] of Object.entries(opts ?? {})) {
				if (value !== undefined) serializerInputs[field] = value;
			}
			return page<RespondEnvelope>(id, {
				component,
				url,
				props: props as never,
				...(Object.keys(serializerInputs).length > 0 ? { inputs: serializerInputs } : {}),
			});
		},
	};
	return def;
}

/**
 * A typed read of a step this workflow did not declare — a middleware's output
 * (`inertia.shared`, `inertia.auth`, #996/#1015) or any other pre-populated
 * state key. Identical to `makeHandle`, with the node value supplying the type.
 *
 * @example const auth = shared(currentUser, "auth"); // Handle<{ id: string; email: string }>
 */
export function shared<N extends NodeLike>(node: N, stepId: string): Handle<OutputOf<N>> {
	if (!node || typeof node.name !== "string" || node.name.length === 0) {
		throw new Error('shared() requires a node value (from defineNode/runtimeNode). Fix: shared(currentUser, "auth").');
	}
	if (typeof stepId !== "string" || stepId.length === 0) {
		throw new Error('shared() requires the state key the value lives at. Fix: shared(currentUser, "auth").');
	}
	return makeHandle<OutputOf<N>>(stepId);
}
