/**
 * PageNode — the `page` control step (#1008).
 *
 * Inertia's prop taxonomy is *lazy evaluation*: the server declares what a page
 * COULD need and the request decides what actually runs. In Blok a prop is a
 * step, so "which props run" is a control-flow decision — which is exactly what
 * this node is. It:
 *
 *   1. reads the v3 protocol headers off `ctx.request`,
 *   2. computes the resolution set (full visit vs partial reload of THIS
 *      component; `only` then `except`; always forced in; optional/defer only
 *      when explicitly requested),
 *   3. runs the selected prop steps IN PARALLEL, each through the normal
 *      `Runner` so per-prop `retry` / `idempotencyKey` / tracing all apply,
 *      persisting each at `ctx.state["<pageId>.<key>"]`,
 *   4. hands the resolved props + their mode metadata to the SERIALIZER step
 *      (`@blokjs/inertia`), which stays the single owner of the wire format.
 *
 * The runtime config is read from `ctx.config[this.name]` (built by
 * `WorkflowNormalizer.normalizePageStep`):
 *   {
 *     component: string,
 *     url?: unknown,
 *     props: PagePropMeta[],        // index-aligned with steps[0..n-1]
 *     serializer: string,           // the serializer step's name
 *     steps: NodeBase[],            // [...propSteps, serializerStep]
 *   }
 *
 * `merge` and `scroll` resolve exactly like a regular prop and contribute only
 * client-side metadata. `once` is the one mode that changes RESOLUTION: the
 * client tells us which remembered props it still holds
 * (`X-Inertia-Except-Once-Props`) and those steps are not run at all (#1009).
 *
 * Whether a merge label survives onto the wire is the SERIALIZER's call, not
 * this node's: "full visits always replace" and `X-Inertia-Reset` are wire
 * rules, applied once in `@blokjs/inertia`'s `buildPage` so a hand-written
 * serializer step obeys them too.
 */

import { type Context, type NodeBase, type ResponseContext, isStructuralRef, isStructuralTpl } from "@blokjs/shared";
import RunnerNode from "./RunnerNode";
import { deriveNestedAttribution } from "./utils/createChildContext";
import { createScopedExecutionContext } from "./utils/createChildContext";
import type { ExecutionBudget } from "./utils/createChildContext";
import { applyStepOutput } from "./workflow/PersistenceHelper";

/** How a prop is resolved. `merge`/`once`/`scroll` resolve like `regular`. */
export type PagePropMode = "regular" | "always" | "optional" | "defer" | "merge" | "once" | "scroll";

/**
 * One merge direction's target (#1009):
 * `true` (the whole prop), `"data"`, `["a","b"]`, or `{ "users.data": "id" }`
 * — the map form carries the `matchOn` field per path.
 */
export type PageMergeTarget = boolean | string | string[] | Record<string, string>;

/** Client merge-strategy metadata (#1009) — passed through to the serializer. */
export interface PageMergeMeta {
	append?: PageMergeTarget;
	prepend?: PageMergeTarget;
	deep?: string | boolean;
	matchOn?: string;
}

/** Once-prop cache metadata (#1009). */
export interface PageOnceMeta {
	as?: string;
	/** Duration (`"1h"`), SECONDS (`3600`), or an absolute date (ISO / `Date`). */
	until?: string | number | Date;
	/** Resolve and resend even when the client says it still holds the value. */
	fresh?: boolean;
}

/** Infinite-scroll paging DECLARATION (#1010) — how to read the prop, not what it said. */
export interface PageScrollMeta {
	/** Sub-path holding the item array the client grows. Default `"data"`. */
	wrapper?: string;
	/** Query-string parameter the client bumps. Overrides the resolved metadata's own. */
	pageName?: string;
	/** Maps an arbitrary prop output onto the cursor fields. TS authoring only — JSON cannot carry a function. */
	metadata?: (output: never) => unknown;
}

/** One emitted `scrollProps` entry — exactly the five fields the client reads. */
export interface PageScrollProp {
	pageName: string;
	previousPage: number | string | null;
	nextPage: number | string | null;
	currentPage: number | string | null;
	reset: boolean;
}

/** One declared prop: its key, the step that resolves it, and its mode. */
export interface PagePropMeta {
	key: string;
	step: string;
	mode: PagePropMode;
	group?: string;
	rescue?: boolean;
	merge?: PageMergeMeta;
	once?: PageOnceMeta;
	scroll?: PageScrollMeta;
}

interface PageOpts {
	component?: string;
	url?: unknown;
	props?: PagePropMeta[];
	serializer?: string;
	steps?: NodeBase[];
}

/**
 * Lower-case every header name so lookups are case-insensitive.
 *
 * ponytail: a six-line copy of `@blokjs/inertia`'s `normalizeHeaders`. The
 * runner CANNOT import that package — inertia depends on `@blokjs/core`, which
 * is this. Upgrade path if it ever grows: move it to `@blokjs/shared`, which
 * both sides already depend on.
 */
function lowerHeaders(headers: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (headers === null || typeof headers !== "object") return out;
	for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
		if (value === undefined || value === null) continue;
		out[key.toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value);
	}
	return out;
}

// ─────────────────────────── the flash bag (#996) ───────────────────────────

/** What `@blokjs/flash`'s `read` op leaves at `ctx.state.flash`. */
interface FlashState {
	present: boolean;
	errors?: Record<string, unknown>;
	bag?: string;
	flash?: Record<string, unknown>;
	preserveFragment?: boolean;
	clearHistory?: boolean;
	cookie: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Duck-type `ctx.state.flash` against the `@blokjs/flash` read output. Only
 * THAT shape is honored — a page whose own step is called `flash` (a plain prop,
 * a different node) contributes nothing here rather than being misread.
 */
function readFlashState(ctx: Context): FlashState | undefined {
	const candidate = (ctx.state as Record<string, unknown> | undefined)?.flash;
	if (!isRecord(candidate)) return undefined;
	if (typeof candidate.present !== "boolean" || typeof candidate.cookie !== "string") return undefined;
	return candidate as unknown as FlashState;
}

/**
 * Is this serializer input still an UNRESOLVED author reference?
 *
 * `flashInputs` runs BEFORE `runSerializer` hands the inputs to the inner
 * Runner, so a handle the author passed to `render()` — `errors:
 * validation.errors` — is at this point a structural `{$ref}` / `{$tpl}`
 * object, or the `js/…` string it lowers to. Both are opaque here: their VALUE
 * does not exist yet, so there is nothing to merge with.
 */
function isUnresolved(value: unknown): boolean {
	if (typeof value === "string") return value.startsWith("js/");
	if (typeof value !== "object" || value === null) return false;
	return isStructuralRef(value) || isStructuralTpl(value);
}

/** A value we may merge the middleware's into: absent, or an already-plain record. */
function isMergeable(value: unknown): value is Record<string, unknown> | undefined {
	return value === undefined || (isRecord(value) && !isUnresolved(value));
}

/**
 * Fold the `inertia.shared` flash bag into the serializer's inputs, so a page
 * never has to wire `errors` / `flash` / the clearing cookie by hand.
 *
 * `explicit` is what the author passed through `render()`'s options; it WINS
 * everywhere, with two deliberate exceptions that merge instead of replacing:
 * `errors` and `flash` are objects whose keys come from two different places
 * (the failed write that redirected, and this render), so the author's keys sit
 * ON TOP of the middleware's rather than erasing them.
 *
 * A merge is only possible against a RESOLVED record. When the author passed a
 * handle or expression instead, it stays untouched and wins WHOLE — spreading
 * `{ ...state.errors, $ref: {…} }` would both corrupt the errors object and
 * break the reference.
 */
function flashInputs(ctx: Context, explicit: Record<string, unknown>): Record<string, unknown> {
	const state = readFlashState(ctx);
	if (!state) return {};
	const out: Record<string, unknown> = {};

	if (isMergeable(explicit.errors)) {
		const merged = { ...(state.errors ?? {}), ...(explicit.errors ?? {}) };
		if (Object.keys(merged).length > 0) out.errors = merged;
	}

	if (isMergeable(explicit.flash)) {
		const merged = { ...(state.flash ?? {}), ...(explicit.flash ?? {}) };
		if (Object.keys(merged).length > 0) out.flash = merged;
	}

	// These three are only ever CONSUMED when the author said nothing, so an
	// unresolved value is already safe — it is simply left in place.
	if (explicit.errorBag === undefined && state.bag !== undefined) out.errorBag = state.bag;
	if (explicit.preserveFragment === undefined && state.preserveFragment === true) out.preserveFragment = true;
	// `clearHistory` only ever travels as `true` (#1013): a `false` here would
	// override a mark set by `logoutResponse()` earlier in the SAME request.
	if (explicit.clearHistory === undefined && state.clearHistory === true) out.clearHistory = true;

	// One-shot: the response that consumed the flash is the one that expires it.
	// An ARRAY can be appended to even when its elements are refs (the inner
	// Runner resolves each) — but a handle standing in for the whole array
	// cannot, so that case keeps the author's value and forgoes the clearing
	// cookie. ponytail: a page that hands `cookies` a whole-array handle has to
	// append the `flash` step's `cookie` itself; pass an array literal instead.
	if (explicit.cookies === undefined) out.cookies = [state.cookie];
	else if (Array.isArray(explicit.cookies)) out.cookies = [...explicit.cookies, state.cookie];

	return out;
}

/** Split a comma-separated header value into trimmed, non-empty items. */
function headerList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/** `posts.data` names the prop `posts` — dot-notation targets a sub-path of a prop. */
function rootSegment(path: string): string {
	const dot = path.indexOf(".");
	return dot === -1 ? path : path.slice(0, dot);
}

/**
 * Unwrap the `BlokResponse` envelope a module node leaves on `ctx.response`.
 * Same dual shape ForEachNode handles — a raw `RunnerNode` leaves the value
 * itself, a `defineNode` node leaves `{ data, contentType, … }`.
 */
function unwrapResult(resp: unknown): unknown {
	if (resp !== null && typeof resp === "object" && "data" in resp && "contentType" in resp) {
		return (resp as { data: unknown }).data;
	}
	return resp;
}

/** `1h` / `30s` / `500ms` → ms. Anything else → undefined. */
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A once-prop's `until` → the expiry as EPOCH MILLISECONDS, or `null` when it
 * never expires.
 *
 * Milliseconds, not an ISO string, because that is what the client compares:
 * `@inertiajs/core` filters its remembered entries with
 * `onceProp.expiresAt > Date.now()`. An ISO string loses that comparison every
 * time, so the client would treat every entry as expired and never send
 * `X-Inertia-Except-Once-Props` — the whole feature, silently off.
 *
 * `until` is read the way Laravel's `until()` reads it: a DURATION from now
 * (`"1h"`, `"500ms"`), a number of SECONDS, or an ABSOLUTE date (a `Date`, or
 * anything `Date.parse` accepts).
 */
function onceExpiry(until: string | number | Date | undefined): number | null {
	if (until === undefined) return null;
	if (until instanceof Date) return Number.isNaN(until.getTime()) ? null : until.getTime();
	if (typeof until === "number") return Date.now() + until * 1000;
	const match = DURATION.exec(until.trim());
	if (match) return Date.now() + Number(match[1]) * (DURATION_UNITS[match[2]] as number);
	const parsed = Date.parse(until);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Has an ABSOLUTE `until` already passed? A relative duration is measured from
 * NOW, so it is never expired at emission time and this is always `false` —
 * enforcing THAT deadline is the client's job (it stops listing the key). An
 * absolute one the server can and must check itself.
 */
function onceExpired(until: string | number | Date | undefined): boolean {
	const expiry = onceExpiry(until);
	return expiry !== null && expiry <= Date.now();
}

/**
 * Does this once-prop resolve on THIS request?
 *
 * `explicit` is a partial reload naming it in `only` — the client asking for a
 * fresh copy outranks everything. Otherwise it resolves unless the client says
 * it still holds a live copy (`X-Inertia-Except-Once-Props`), with `fresh`
 * forcing a resolve and an elapsed absolute `until` invalidating the claim.
 */
function resolveOnce(prop: PagePropMeta, exceptOnce: Set<string>, explicit: boolean): boolean {
	if (explicit) return true;
	const once = prop.once ?? {};
	if (once.fresh === true) return true;
	if (!exceptOnce.has(once.as ?? prop.key)) return true;
	return onceExpired(once.until);
}

/**
 * One merge direction → the `[path, matchOn?]` pairs it labels (#1009).
 *
 * `true` targets the prop itself, a string a sub-path (`"data"` →
 * `<key>.data`), an array several of them, and the map form pairs each path
 * with the field the client matches items on (`{ "users.data": "id" }`).
 */
function mergeTargets(key: string, target: PageMergeTarget | undefined): Array<[string, string | undefined]> {
	if (target === undefined || target === false) return [];
	const path = (suffix?: string) => (suffix ? `${key}.${suffix}` : key);
	if (target === true) return [[key, undefined]];
	if (typeof target === "string") return [[path(target), undefined]];
	if (Array.isArray(target)) return target.map((suffix) => [path(suffix), undefined]);
	return Object.entries(target).map(([suffix, field]) => [path(suffix), field]);
}

/** The prop-metadata bundle the serializer needs. Every field is optional on the wire. */
interface PageMetadata {
	alwaysProps?: string[];
	deferredProps?: Record<string, string[]>;
	rescuedProps?: string[];
	mergeProps?: string[];
	prependProps?: string[];
	deepMergeProps?: string[];
	matchPropsOn?: string[];
	onceProps?: Record<string, { prop: string; expiresAt: number | null }>;
	scrollProps?: Record<string, PageScrollProp>;
}

/** The four cursor fields, off whatever the prop (or its resolver) produced. */
const CURSOR_FIELDS = ["pageName", "previousPage", "nextPage", "currentPage"] as const;

function cursor(source: Record<string, unknown>, field: "previousPage" | "nextPage" | "currentPage") {
	const value = source[field];
	return typeof value === "number" || typeof value === "string" ? value : null;
}

/**
 * A scroll prop's `scrollProps` entry, read from the RESOLVED output (#1010).
 *
 * The cursors describe the page that was just produced, so they cannot be
 * static declaration data: every scroll response re-emits a fresh set. Either
 * the output already satisfies the contract (what `paginate()` /
 * `cursorPaginate()` return) or `metadata` maps an arbitrary shape onto it.
 *
 * A `pageName` declared on the mode wins over the output's own — it is how two
 * scroll props on one page are given non-colliding query parameters.
 */
function scrollProp(key: string, meta: PageScrollMeta, output: unknown): PageScrollProp {
	const resolver = meta.metadata;
	const raw = typeof resolver === "function" ? (resolver as (value: unknown) => unknown)(output) : output;
	if (!isRecord(raw) || !CURSOR_FIELDS.some((field) => Object.hasOwn(raw, field))) {
		throw new Error(
			`[blok] page prop "${key}" is declared \`scroll()\` but its output carries none of ${CURSOR_FIELDS.join(
				", ",
			)}. Return through \`paginate()\` / \`cursorPaginate()\` from @blokjs/inertia, or give the mode a \`metadata\` resolver.`,
		);
	}
	return {
		pageName: meta.pageName ?? (typeof raw.pageName === "string" ? raw.pageName : "page"),
		previousPage: cursor(raw, "previousPage"),
		nextPage: cursor(raw, "nextPage"),
		currentPage: cursor(raw, "currentPage"),
		// The wire always carries the flag; the SERIALIZER flips it when the
		// client's `X-Inertia-Reset` names this prop, same as it strips the label.
		reset: false,
	};
}

export class PageNode extends RunnerNode {
	async run(ctx: Context): Promise<ResponseContext> {
		this.contentType = "application/json";

		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as PageOpts;
		const component = typeof opts.component === "string" ? opts.component : "";
		const props = Array.isArray(opts.props) ? opts.props : [];
		const steps = (opts.steps ?? []) as NodeBase[];
		if (!component) {
			throw new Error(`[blok] page step "${this.name}": \`component\` is required.`);
		}
		if (steps.length !== props.length + 1) {
			throw new Error(
				`[blok] page step "${this.name}": expected ${props.length + 1} inner steps (one per prop plus the serializer), got ${steps.length}.`,
			);
		}

		const request = (ctx.request ?? {}) as Record<string, unknown>;
		const headers = lowerHeaders(request.headers);
		const partial = headers["x-inertia"] === "true" && headers["x-inertia-partial-component"] === component;

		const selection = selectProps(props, headers, partial);

		// --- resolve the selected props in parallel ---------------------------
		const resolved: Record<string, unknown> = {};
		const rescued: string[] = [];
		// Failures are COLLECTED, not thrown from inside the map: a bare
		// `Promise.all` rejects on the first one and leaves its siblings running
		// against a ctx nobody is reading any more. Let every prop settle, then
		// fail the step with the first real error.
		const failures: unknown[] = [];
		await Promise.all(
			selection.run.map(async (prop) => {
				const index = props.indexOf(prop);
				try {
					const value = await this.runProp(ctx, steps[index] as NodeBase, index);
					resolved[prop.key] = value;
					// The per-prop state slot is the author-visible one — same contract
					// as any other step's, so `run.state("page.orders")` just works.
					(ctx.state as Record<string, unknown>)[prop.step] = value;
				} catch (error) {
					// `rescue` OMITS the prop and reports it; it does NOT swallow the
					// failure — the inner Runner already recorded the failed NodeRun,
					// and this log keeps it visible to an operator tailing stdout.
					if (prop.rescue !== true) {
						failures.push(error);
						return;
					}
					rescued.push(prop.key);
					ctx.logger.log(
						`[blok] page step "${this.name}": prop "${prop.key}" failed and was rescued: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}),
		);
		if (failures.length > 0) throw failures[0];

		// --- hand everything to the serializer -------------------------------
		const metadata = buildMetadata(props, selection, resolved, rescued);
		const serializer = steps[props.length] as NodeBase;
		const explicitInputs = ((ctx.config as Record<string, Record<string, unknown>> | undefined)?.[serializer.name]
			?.inputs ?? {}) as Record<string, unknown>;
		const serializerInputs = {
			...explicitInputs,
			component,
			props: resolved,
			...(opts.url !== undefined ? { url: opts.url } : {}),
			headers: request.headers ?? {},
			method: request.method ?? "GET",
			...metadata,
			// #1015 — the shared-prop registry lives in `@blokjs/inertia` and is
			// resolved by the SERIALIZER: the runner cannot import that package (the
			// dependency runs the other way), and the serializer is the one place
			// EVERY Inertia response passes through, `page` step or not. So nothing
			// is injected here — an author's own `sharedProps` input rides
			// `explicitInputs` above, and the serializer unions the registry's keys
			// into it.
			// #996 — the flash bag `inertia.shared` left at `ctx.state.flash`:
			// validation errors, page flash, the error bag, preserveFragment,
			// clearHistory and the cookie that expires it. Absent middleware (or a
			// `flash` state slot of another shape) contributes nothing.
			...flashInputs(ctx, explicitInputs),
		};

		// The serializer's own `BlokResponse` envelope IS this step's result: the
		// runner sets `ctx.response = model.data`, and the HTTP trigger reads the
		// `RespondEnvelope` off `ctx.response.data`. Handing back anything
		// unwrapped here would make the page step the one step whose output the
		// response emitter cannot read.
		const envelope = await this.runSerializer(ctx, serializer, serializerInputs);
		if (typeof (envelope as { contentType?: string })?.contentType === "string") {
			this.contentType = (envelope as { contentType: string }).contentType;
		}
		applyStepOutput(ctx, this, envelope as { data?: unknown });
		return { success: true, data: envelope, error: null };
	}

	/** Run one prop's step through the normal Runner, in its own scoped ctx. */
	private async runProp(ctx: Context, step: NodeBase, index: number): Promise<unknown> {
		const childCtx = this.childContext(ctx, index);
		const { default: Runner } = await import("./Runner");
		await new Runner([step]).run(childCtx, { deep: true, stepName: this.name });
		return unwrapResult(childCtx.response);
	}

	/**
	 * Run the serializer step with the runtime-computed inputs merged over its
	 * static ones, returning its `BlokResponse` envelope verbatim.
	 */
	private async runSerializer(ctx: Context, step: NodeBase, inputs: Record<string, unknown>): Promise<unknown> {
		const childCtx = this.childContext(ctx, -1);
		(childCtx.config as Record<string, unknown>)[step.name] = { inputs };
		const { default: Runner } = await import("./Runner");
		await new Runner([step]).run(childCtx, { deep: true, stepName: this.name });
		return childCtx.response;
	}

	/**
	 * A per-prop child ctx: own `state` + `config` copies so two props resolving
	 * concurrently cannot bleed resolved slices into each other (the same
	 * isolation ForEachNode's parallel mode uses).
	 */
	private childContext(ctx: Context, index: number): Context {
		const state = { ...((ctx.state ?? {}) as Record<string, unknown>) };
		const childCtx = {
			...ctx,
			state,
			vars: state,
			config: { ...ctx.config },
			response: { data: null, success: true, error: null, contentType: "application/json" },
		} as Context;
		const parentBudget = (ctx._PRIVATE_ as { budget?: ExecutionBudget } | null)?.budget;
		createScopedExecutionContext(ctx, childCtx, {
			attribution: deriveNestedAttribution(ctx, `page:${this.name}`, {
				branchId: `${this.name}:${index}`,
				branchIndex: index,
			}),
			...(parentBudget ? { budget: parentBudget } : {}),
		});
		// Studio origin badge. ponytail: reuses the middleware origin channel
		// RunnerSteps already surfaces on every NodeRun (`mw:<name>`), so a page's
		// inner prop steps render exactly like middleware inner steps — zero trace
		// schema change. Upgrade path: a dedicated `origin` column if the two ever
		// need to be told apart.
		(childCtx as Record<string, unknown>)._blokMiddlewareName = `page:${this.name}`;
		return childCtx;
	}
}

interface Selection {
	run: PagePropMeta[];
	partial: boolean;
}

/**
 * The v3 resolution table.
 *
 * Full visit (or a partial naming a DIFFERENT component — the client navigated
 * away, so narrowed props would be wrong):
 *   run `regular` + `always` + `merge` + `scroll`, and `once` unless the client
 *   says it still holds the cached copy (`X-Inertia-Except-Once-Props`);
 *   `optional` and `defer` do NOT run.
 *
 * Partial reload of THIS component:
 *   `only` (dot paths target a prop's sub-path, so the ROOT segment selects the
 *   prop) narrows first, then `except` removes whole props; `always` props are
 *   exempt from both; `optional` and `defer` run ONLY when explicitly named in
 *   `only`.
 *
 * A `once` prop is NOT a lazy mode: it belongs to the regular set on a full
 * visit AND on a partial without `only`, and stays out only while the client
 * says it still holds a live copy. Naming it in `only` always resolves it.
 */
function selectProps(props: PagePropMeta[], headers: Record<string, string>, partial: boolean): Selection {
	const onlyRoots = new Set(headerList(headers["x-inertia-partial-data"]).map(rootSegment));
	const exceptExact = new Set(headerList(headers["x-inertia-partial-except"]));
	const exceptOnce = new Set(headerList(headers["x-inertia-except-once-props"]));
	const narrowed = partial && onlyRoots.size > 0;

	const run = props.filter((prop) => {
		if (prop.mode === "always") return true;
		// `only` narrows to exactly what it names — including the lazy modes.
		if (narrowed) return onlyRoots.has(prop.key);
		// Full visit, or a partial without `only`: the regular set runs.
		if (prop.mode === "optional" || prop.mode === "defer") return false;
		if (prop.mode === "once") return resolveOnce(prop, exceptOnce, false);
		return true;
	});

	// `except` never overrides an always-prop; a dot path (`posts.data`) narrows
	// INSIDE the prop, which is the serializer's job, so only an exact key skips
	// the resolution entirely.
	const filtered = run.filter((prop) => prop.mode === "always" || !exceptExact.has(prop.key));
	return { run: filtered, partial };
}

/** Turn the declared modes into the page object's prop-metadata fields. */
function buildMetadata(
	props: PagePropMeta[],
	selection: Selection,
	resolved: Record<string, unknown>,
	rescued: string[],
): PageMetadata {
	const meta: PageMetadata = {};
	const alwaysProps: string[] = [];
	const deferredProps: Record<string, string[]> = {};
	const mergeProps: string[] = [];
	const prependProps: string[] = [];
	const deepMergeProps: string[] = [];
	const matchPropsOn: string[] = [];
	const onceProps: Record<string, { prop: string; expiresAt: number | null }> = {};
	const scrollProps: Record<string, PageScrollProp> = {};

	for (const prop of props) {
		if (prop.mode === "always") alwaysProps.push(prop.key);
		if (prop.mode === "defer" && !selection.run.includes(prop)) {
			const group = prop.group ?? "default";
			const bucket = deferredProps[group] ?? [];
			bucket.push(prop.key);
			deferredProps[group] = bucket;
		}
		// Labels describe props that are actually IN this response.
		const present = Object.hasOwn(resolved, prop.key);
		// The mode is the RESOLUTION rule; the metadata bags are independent, so a
		// composed prop — `defer(merge(node, …))` — carries mode `defer` and still
		// labels itself for the client (#1009). A JSON prop that sets only
		// `mode: "merge"` gets the default (root append) bag.
		const mergeMeta = prop.merge ?? (prop.mode === "merge" ? {} : undefined);
		const onceMeta = prop.once ?? (prop.mode === "once" ? {} : undefined);
		const scrollMeta = prop.scroll ?? (prop.mode === "scroll" ? {} : undefined);

		if (mergeMeta && present) {
			const appends = mergeTargets(prop.key, mergeMeta.append);
			const prepends = mergeTargets(prop.key, mergeMeta.prepend);
			const deeps = mergeTargets(prop.key, mergeMeta.deep);
			// Plain `merge(node)` means "append the whole prop".
			if (appends.length + prepends.length + deeps.length === 0) appends.push([prop.key, undefined]);
			for (const [path] of appends) mergeProps.push(path);
			for (const [path] of prepends) prependProps.push(path);
			for (const [path] of deeps) deepMergeProps.push(path);
			// `<mergePath>.<field>` — the client splits on the LAST dot and matches
			// the head against the merge path, so the field rides the path it
			// belongs to. A per-path field (the map form) wins over the shared one.
			for (const [path, field] of [...appends, ...prepends, ...deeps]) {
				const on = field ?? mergeMeta.matchOn;
				if (on !== undefined && !matchPropsOn.includes(`${path}.${on}`)) matchPropsOn.push(`${path}.${on}`);
			}
		}
		// The once entry describes the CACHE, not the payload, so it ships even
		// when the value does not: a skipped once prop whose entry went missing
		// would read to the client as "your copy is stale, forget it" — exactly
		// the opposite of what the skip means.
		if (onceMeta) {
			onceProps[onceMeta.as ?? prop.key] = { prop: prop.key, expiresAt: onceExpiry(onceMeta.until) };
		}
		// The entry is keyed by the PROP, which is what `<InfiniteScroll data="posts">`
		// looks up (`page.scrollProps[propName]` in @inertiajs/core). The merge
		// label goes on the WRAPPER path instead: the client grows the item array
		// and replaces the cursors around it.
		if (scrollMeta && present) {
			const wrapper = scrollMeta.wrapper ?? "data";
			const path = wrapper ? `${prop.key}.${wrapper}` : prop.key;
			scrollProps[prop.key] = scrollProp(prop.key, scrollMeta, resolved[prop.key]);
			if (!mergeProps.includes(path)) mergeProps.push(path);
		}
	}

	if (alwaysProps.length > 0) meta.alwaysProps = alwaysProps;
	if (Object.keys(deferredProps).length > 0) meta.deferredProps = deferredProps;
	if (rescued.length > 0) meta.rescuedProps = rescued;
	if (mergeProps.length > 0) meta.mergeProps = mergeProps;
	if (prependProps.length > 0) meta.prependProps = prependProps;
	if (deepMergeProps.length > 0) meta.deepMergeProps = deepMergeProps;
	if (matchPropsOn.length > 0) meta.matchPropsOn = matchPropsOn;
	if (Object.keys(onceProps).length > 0) meta.onceProps = onceProps;
	if (Object.keys(scrollProps).length > 0) meta.scrollProps = scrollProps;
	return meta;
}

export default PageNode;
