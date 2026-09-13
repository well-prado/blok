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
 * NOT implemented here (deliberately): the RESOLUTION semantics of
 * `merge` / `once` / `scroll` (#1009 / #1010). Those modes resolve exactly like
 * a regular prop and contribute only their client-side metadata, so the
 * features can land later without touching this executor.
 */

import type { Context, NodeBase, ResponseContext } from "@blokjs/shared";
import RunnerNode from "./RunnerNode";
import { deriveNestedAttribution } from "./utils/createChildContext";
import { createScopedExecutionContext } from "./utils/createChildContext";
import type { ExecutionBudget } from "./utils/createChildContext";
import { applyStepOutput } from "./workflow/PersistenceHelper";

/** How a prop is resolved. `merge`/`once`/`scroll` resolve like `regular`. */
export type PagePropMode = "regular" | "always" | "optional" | "defer" | "merge" | "once" | "scroll";

/** Client merge-strategy metadata (#1009) — passed through to the serializer. */
export interface PageMergeMeta {
	append?: string;
	prepend?: string;
	deep?: string | boolean;
	matchOn?: string;
}

/** Once-prop cache metadata (#1009). */
export interface PageOnceMeta {
	as?: string;
	until?: string | number;
}

/** Infinite-scroll paging metadata (#1010). */
export interface PageScrollMeta {
	wrapper?: string;
	pageName?: string;
	previousPage?: number | string | null;
	nextPage?: number | string | null;
	currentPage?: number | string | null;
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

/** A once-prop's `until` → an ISO expiry, or `null` when it never expires. */
function onceExpiry(until: string | number | undefined): string | null {
	if (until === undefined) return null;
	if (typeof until === "number") return new Date(Date.now() + until).toISOString();
	const match = DURATION.exec(until.trim());
	if (match) return new Date(Date.now() + Number(match[1]) * (DURATION_UNITS[match[2]] as number)).toISOString();
	const parsed = Date.parse(until);
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
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
	onceProps?: Record<string, { prop: string; expiresAt: string | null }>;
	scrollProps?: Record<string, PageScrollMeta & { pageName: string }>;
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
		const runs = selection.run.map(async (prop) => {
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
				if (prop.rescue !== true) throw error;
				rescued.push(prop.key);
				ctx.logger.log(
					`[blok] page step "${this.name}": prop "${prop.key}" failed and was rescued: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		});
		await Promise.all(runs);

		// --- hand everything to the serializer -------------------------------
		const metadata = buildMetadata(props, selection, resolved, rescued);
		const serializer = steps[props.length] as NodeBase;
		const serializerInputs = {
			...((ctx.config as Record<string, Record<string, unknown>> | undefined)?.[serializer.name]?.inputs ?? {}),
			component,
			props: resolved,
			...(opts.url !== undefined ? { url: opts.url } : {}),
			headers: request.headers ?? {},
			method: request.method ?? "GET",
			...metadata,
			// #1015 / #996 seams — the shared-prop registry and the flash bag do not
			// exist yet. They ride the SAME serializer inputs when they land.
			sharedProps: [],
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
 *   exempt from both; `optional`, `defer` and `once` run ONLY when explicitly
 *   named in `only`.
 */
function selectProps(props: PagePropMeta[], headers: Record<string, string>, partial: boolean): Selection {
	const onlyRoots = new Set(headerList(headers["x-inertia-partial-data"]).map(rootSegment));
	const exceptExact = new Set(headerList(headers["x-inertia-partial-except"]));
	const exceptOnce = new Set(headerList(headers["x-inertia-except-once-props"]));

	const run = props.filter((prop) => {
		if (prop.mode === "always") return true;
		const requested = onlyRoots.has(prop.key);
		if (!partial) {
			if (prop.mode === "optional" || prop.mode === "defer") return false;
			if (prop.mode === "once") return !exceptOnce.has(prop.once?.as ?? prop.key);
			return true;
		}
		if (onlyRoots.size > 0) return requested;
		// A partial without `only` reloads the regular set. Lazy modes stay lazy:
		// the client has to ask for them by name.
		return prop.mode !== "optional" && prop.mode !== "defer" && prop.mode !== "once";
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
	const onceProps: Record<string, { prop: string; expiresAt: string | null }> = {};
	const scrollProps: Record<string, PageScrollMeta & { pageName: string }> = {};

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
		if (prop.mode === "merge" && present) {
			const m = prop.merge ?? {};
			const path = (suffix?: string) => (suffix ? `${prop.key}.${suffix}` : prop.key);
			if (m.prepend !== undefined) prependProps.push(path(m.prepend));
			if (m.deep !== undefined) deepMergeProps.push(path(typeof m.deep === "string" ? m.deep : undefined));
			if (m.append !== undefined || (m.prepend === undefined && m.deep === undefined)) {
				mergeProps.push(path(m.append));
			}
			if (m.matchOn !== undefined) matchPropsOn.push(`${path(m.append ?? m.prepend)}.${m.matchOn}`);
		}
		if (prop.mode === "once" && present) {
			onceProps[prop.once?.as ?? prop.key] = { prop: prop.key, expiresAt: onceExpiry(prop.once?.until) };
		}
		if (prop.mode === "scroll" && present) {
			const s = prop.scroll ?? {};
			const path = s.wrapper ? `${prop.key}.${s.wrapper}` : prop.key;
			scrollProps[path] = { ...s, pageName: s.pageName ?? "page" };
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
