/**
 * `@blokjs/inertia` — the Inertia **v3** protocol adapter node.
 *
 * It is the SERIALIZER, not the prop resolver: optional/deferred/merge/once/
 * scroll resolution is the `page` control step's job (#1008). This node takes
 * already-resolved props plus their metadata, applies the wire-level rules
 * (partial narrowing, reset, version check) and emits a `RespondEnvelope` —
 * an HTML document on the first load, the bare page object on an Inertia XHR.
 */

import { defineNode } from "@blokjs/core";
import { RESPOND_BRAND, type RespondEnvelope } from "@blokjs/shared";
import { z } from "zod";
import { flashCookie, normalizeErrors } from "./flash.js";
import { buildPage, isInertiaRequest } from "./page.js";
import { type PageObject, location, normalizeHeaders, redirect, renderShell, versionConflict } from "./protocol.js";
// #1015 — the adapter-wide url / component overrides, and the shared-data
// registry. The serializer is where shared values are RESOLVED: it is the one
// place every Inertia response passes through.
import { resolveUrl, transformComponent } from "./routing.js";
// #1013 — the request mark left by the `inertia.encryptHistory` middleware and
// by `logoutResponse()`, plus the adapter-wide `history.encrypt` default.
import { resolveClearHistory, resolveEncryptHistory } from "./security/history.js";
import { resolveSharedProps } from "./shared.js";

export {
	APP_MARKER,
	DEFAULT_SHELL,
	HEAD_MARKER,
	clearHistory,
	encryptHistory,
	location,
	redirect,
	renderShell,
	serializePage,
	versionConflict,
} from "./protocol.js";
export type { OnceProp, PageObject, RedirectOptions, RenderShellOptions, ScrollProp } from "./protocol.js";
export { buildPage, isInertiaRequest, isPartialReload } from "./page.js";
export type { BuildPageInput, PageMetadata } from "./page.js";
export * from "./security/index.js";
export { back, flash, flashCookie, normalizeErrors, redirectBack } from "./flash.js";
export type { FlashBuilder, FlashPayload, FlashPersistOptions, FlashRequest, RedirectBackOptions } from "./flash.js";
export * from "./middleware/index.js";
// --- production error pages (#1014) ------------------------------------------
export * from "./errors.js";

// --- typed page contracts (#995, v3 shape per #1008) -------------------------
export {
	_resetPageRegistry,
	always,
	defer,
	definePage,
	getPageRegistry,
	merge,
	once,
	optional,
	scroll,
	shared,
} from "./define-page.js";
export { withProps } from "./define-page.js";
// --- pagination envelopes for `scroll()` props (#1010) -----------------------
export {
	cursorPaginate,
	cursorPaginatedSchema,
	paginate,
	paginatedSchema,
	scrollMetadataSchema,
} from "./paginate.js";
export type {
	CursorPaginateOptions,
	CursorPaginated,
	PaginateOptions,
	Paginated,
	ScrollMetadata,
} from "./paginate.js";
// --- shared data + routing (#1015) -------------------------------------------
export { _resetShared, getShared, share, shareOnce, sharedKeys } from "./shared.js";
export type { ShareOnceOptions, ShareOptions, SharedMode, SharedNode, SharedResolver } from "./shared.js";
export {
	_resetRoutes,
	ensurePagesExist,
	inertia,
	inertiaPage,
	resolveUrlUsing,
	transformComponentUsing,
} from "./routing.js";
export type { ComponentTransform, EnsurePagesExistOptions, InertiaRouteOptions, UrlResolver } from "./routing.js";
export type {
	DeferOptions,
	MergeOptions,
	MergeTarget,
	ModeProp,
	NodeLike,
	OnceOptions,
	PageDef,
	PageProps,
	PageRegistryEntry,
	PageRegistryProp,
	PageShape,
	PropMode,
	PropsOf,
	PropValue,
	RenderInputs,
	RenderOptions,
	ScrollOptions,
} from "./define-page.js";

const scrollPropSchema = z.object({
	pageName: z.string(),
	previousPage: z.union([z.number(), z.string(), z.null()]).optional(),
	nextPage: z.union([z.number(), z.string(), z.null()]).optional(),
	currentPage: z.union([z.number(), z.string(), z.null()]).optional(),
	reset: z.boolean().optional(),
});

const inputSchema = z.object({
	component: z
		.string()
		.min(1)
		.optional()
		.describe("Client-side page component name, e.g. 'Users/Index'. Required unless redirecting."),
	props: z
		.record(z.unknown())
		.optional()
		.describe("Already-resolved page props. #1008 resolves them; this node ships them."),
	url: z.string().optional().describe("Page URL written into the page object. Defaults to the current request URL."),
	version: z.string().optional().describe("Asset version. '' means untracked (no version checking)."),
	errors: z
		.record(z.unknown())
		.optional()
		.describe("Validation errors. Always emitted as props.errors ({} when none)."),
	errorBag: z
		.string()
		.optional()
		.describe(
			"Error-bag name the errors nest under. Overrides X-Inertia-Error-Bag — a bag persisted " +
				"across a redirect (#996) rides the flash cookie, not the follow-up request's headers.",
		),
	withAllErrors: z
		.boolean()
		.optional()
		.describe("true ships EVERY message per field (string[]); default is one message per field (string)."),
	cookies: z
		.array(z.string())
		.optional()
		.describe("Raw Set-Cookie values to emit, e.g. the clearing flash cookie from the `flash` middleware step (#996)."),

	// --- request surface (supplied by the page control step / definePage) ---
	headers: z.record(z.unknown()).optional().describe("Request headers. Defaults to ctx.request.headers."),
	method: z.string().optional().describe("Request method. Defaults to ctx.request.method."),

	// --- prop metadata, emitted verbatim ---
	mergeProps: z.array(z.string()).optional().describe("Prop paths the client appends to instead of replacing."),
	prependProps: z.array(z.string()).optional().describe("Prop paths the client prepends to."),
	deepMergeProps: z.array(z.string()).optional().describe("Prop paths the client deep-merges."),
	matchPropsOn: z.array(z.string()).optional().describe("'<propPath>.<keyField>' entries used to de-duplicate merges."),
	scrollProps: z.record(scrollPropSchema).optional().describe("Infinite-scroll paging metadata, keyed by prop path."),
	deferredProps: z
		.record(z.array(z.string()))
		.optional()
		.describe("Group -> prop keys the client fetches next. Full visits only."),
	rescuedProps: z
		.array(z.string())
		.optional()
		.describe("Deferred props recovered on this partial reload. Partials only."),
	sharedProps: z
		.array(z.string())
		.optional()
		.describe("Top-level shared prop keys, so instant visits know what is shared."),
	onceProps: z
		.record(z.object({ prop: z.string(), expiresAt: z.number().nullable().optional() }))
		.optional()
		.describe(
			"Cache key -> { prop, expiresAt }. expiresAt is epoch MILLISECONDS (the client compares it " +
				"against Date.now()); null when the entry never expires.",
		),
	flash: z.record(z.unknown()).optional().describe("Flash data. Emitted only when non-empty."),
	alwaysProps: z.array(z.string()).optional().describe("Prop paths that survive every partial-reload filter."),
	exposeSharedPropKeys: z.boolean().optional().describe("false hides the sharedProps key list from the page object."),
	encryptHistory: z.boolean().optional().describe("true encrypts this history entry client-side."),
	clearHistory: z.boolean().optional().describe("true clears the client's history state."),
	preserveFragment: z.boolean().optional().describe("true keeps the current URL fragment across the visit."),

	// --- HTML shell (first load only) ---
	rootId: z.string().optional().describe("Root element id and data-page attribute value. Default 'app'."),
	shell: z.string().optional().describe("HTML shell template. Must contain <!--blok:app-->."),
	head: z.string().optional().describe("Markup injected at <!--blok:head-->."),
	viewData: z.record(z.unknown()).optional().describe("Shell-template values ({{key}}). NEVER sent to the client."),

	// --- control responses ---
	redirect: z
		.string()
		.optional()
		.describe("Redirect target. 303 after PUT/PATCH/DELETE; 409 + X-Inertia-Redirect for a fragment."),
	location: z.string().optional().describe("External/hard visit target. Emits 409 + X-Inertia-Location."),
});

const outputSchema = z.object({
	[RESPOND_BRAND]: z.literal(true),
	body: z.unknown().optional(),
	status: z.number().optional(),
	contentType: z.string().optional(),
	headers: z.record(z.string()).optional(),
	cookies: z.array(z.string()).optional(),
});

/** `Vary: X-Inertia` — the same URL answers HTML or JSON depending on it. */
const VARY: Record<string, string> = { Vary: "X-Inertia" };

function requestField(ctx: unknown, field: "headers" | "method" | "url"): unknown {
	const request = (ctx as { request?: Record<string, unknown> } | undefined)?.request;
	return request?.[field];
}

/** Both lists, in order, without duplicates. `undefined` when neither has anything. */
function union(a: string[] | undefined, b: string[]): string[] | undefined {
	if (b.length === 0) return a;
	return [...new Set([...(a ?? []), ...b])];
}

/**
 * The page object rides the browser's history state, and browsers cap it —
 * Firefox hard-fails at 16 MiB, which surfaces client-side as a navigation that
 * simply does not happen. Warn ONCE per process well below that, and still send
 * the response: the page works, the Back button eventually will not.
 *
 * ponytail: this measures by serializing the page a second time (the JSON path
 * hands the object to the trigger, which stringifies it again). One extra pass
 * on a render is cheap next to a silent history failure; the upgrade path is to
 * measure the emitted body in the response emitter and report back.
 */
const HISTORY_WARN_BYTES = 8 * 1024 * 1024;
let warnedOversized = false;

function warnOversizedPage(ctx: unknown, page: PageObject): void {
	if (warnedOversized) return;
	const bytes = JSON.stringify(page).length;
	if (bytes <= HISTORY_WARN_BYTES) return;
	warnedOversized = true;
	const logger = (ctx as { logger?: { logLevel?: (level: string, message: string) => void } } | undefined)?.logger;
	const size = (bytes / 1024 / 1024).toFixed(1);
	const message = `[blok] @blokjs/inertia: page "${page.component}" is ${size} MiB — browsers store the page object in history state and Firefox hard-fails above 16 MiB. Fix: move the bulk behind defer()/optional() props, or paginate it. (Warned once per process.)`;
	if (typeof logger?.logLevel === "function") logger.logLevel("warn", message);
	else console.warn(message);
}

/** Test-only: re-arm the once-per-process history-size warning. */
export function _resetOversizedWarning(): void {
	warnedOversized = false;
}

/**
 * The 409 re-flash could not be signed — report it once and carry on.
 *
 * The re-flash is a nicety (a toast survives the client's re-visit); the 409
 * itself is what makes the app work. An app that never configured
 * `BLOK_FLASH_SECRET` should not have its stale-asset visits 500 over a toast,
 * so this degrades to a plain conflict and names the fix once per process.
 */
let warnedReflash = false;

function warnReflashSkipped(ctx: unknown, error: unknown): void {
	if (warnedReflash) return;
	warnedReflash = true;
	const logger = (ctx as { logger?: { logLevel?: (level: string, message: string) => void } } | undefined)?.logger;
	const reason = error instanceof Error ? error.message : String(error);
	const message = `[blok] @blokjs/inertia: an asset-version 409 could not re-sign the pending flash, so it was dropped — the client will re-visit without it. Reason: ${reason} Fix: set BLOK_FLASH_SECRET (the same value every process uses). (Warned once per process.)`;
	if (typeof logger?.logLevel === "function") logger.logLevel("warn", message);
	else console.warn(message);
}

/** Test-only: re-arm the once-per-process re-flash warning. */
export function _resetReflashWarning(): void {
	warnedReflash = false;
}

/** `http://host/users?page=2` -> `/users?page=2`; anything unparseable is kept. */
function toRelativeUrl(raw: string): string {
	try {
		const parsed = new URL(raw);
		return `${parsed.pathname}${parsed.search}`;
	} catch {
		return raw;
	}
}

export default defineNode({
	name: "@blokjs/inertia",
	description:
		"Serialize an Inertia v3 page object into an HTTP response — HTML shell on first load, JSON page object on an Inertia visit, plus the version/redirect/location control responses.",
	input: inputSchema,
	output: outputSchema,

	async execute(ctx, input): Promise<RespondEnvelope> {
		const headers = normalizeHeaders(
			(input.headers as Record<string, unknown> | undefined) ??
				(requestField(ctx, "headers") as Record<string, unknown> | undefined),
		);
		const method = String(input.method ?? requestField(ctx, "method") ?? "GET").toUpperCase();
		const prefetch = headers.purpose === "prefetch";
		const rawUrl = input.url ?? (requestField(ctx, "url") as string | undefined) ?? "/";
		// #1015 — `resolveUrlUsing()` describes how the WHOLE APP spells URLs, so
		// it wins over the per-page `url`: every real page passes one (it is a
		// required `render()` argument), and an override nothing can reach would
		// be no override at all.
		const url = resolveUrl((ctx as { request?: unknown } | undefined)?.request) ?? toRelativeUrl(rawUrl);
		const version = input.version ?? "";

		// --- control responses come before any page work ---
		if (input.location !== undefined) return location(input.location);
		if (input.redirect !== undefined) {
			const env = redirect(input.redirect, { method, prefetch, preserveFragment: input.preserveFragment });
			return input.cookies?.length ? { ...env, cookies: input.cookies } : env;
		}

		if (!input.component) {
			throw new Error("@blokjs/inertia: `component` is required unless `redirect` or `location` is set.");
		}
		// #1015 — the server-side component rename, applied BEFORE anything else
		// reads the name: the client echoes the transformed name back in
		// `X-Inertia-Partial-Component`, so the partial-reload check has to
		// compare against it too.
		const component = transformComponent(input.component);

		// Asset-version mismatch: only ever on a GET (a non-GET would lose the
		// body if the client replayed it as a fresh visit).
		const clientVersion = headers["x-inertia-version"];
		if (isInertiaRequest(headers) && method === "GET" && clientVersion !== undefined && clientVersion !== version) {
			// #996 — RE-FLASH. This 409 throws the render away and makes the client
			// re-visit, so a flash the request had already consumed (the middleware
			// read and cleared the cookie) would vanish between the two visits.
			// Sign it straight back into a fresh cookie, and drop the clearing
			// cookie that would otherwise cancel it.
			//
			// Opportunistic, so it DEGRADES: signing needs `BLOK_FLASH_SECRET` and
			// throws without it, and losing a toast is not worth 500ing a visit the
			// client only has to repeat. One warning per process names the fix.
			// (`redirectBack()` stays strict — there the flash IS the payload.)
			let reflash: string | undefined;
			try {
				reflash = flashCookie({
					errors: input.errors as Record<string, unknown> | undefined,
					bag: input.errorBag ?? headers["x-inertia-error-bag"],
					flash: input.flash as Record<string, unknown> | undefined,
					preserveFragment: input.preserveFragment,
				});
			} catch (error) {
				warnReflashSkipped(ctx, error);
			}
			const conflict = versionConflict(url, version);
			return reflash ? { ...conflict, cookies: [reflash] } : conflict;
		}

		// #1015 — shared data. Resolved here, merged UNDER the page's own props
		// (the page wins on a key collision), and its top-level keys announced as
		// `sharedProps` so an instant visit can carry them to the next page.
		const pageProps = (input.props as Record<string, unknown> | undefined) ?? {};
		const sharedData = await resolveSharedProps(ctx, headers, component, pageProps);

		const page: PageObject = buildPage({
			component,
			props: { ...sharedData.values, ...pageProps },
			url,
			version,
			errors: normalizeErrors(input.errors as Record<string, unknown> | undefined, {
				withAllErrors: input.withAllErrors,
			}),
			errorBag: input.errorBag ?? headers["x-inertia-error-bag"],
			headers,
			mergeProps: input.mergeProps,
			prependProps: input.prependProps,
			deepMergeProps: input.deepMergeProps,
			matchPropsOn: input.matchPropsOn,
			scrollProps: input.scrollProps,
			deferredProps: input.deferredProps,
			rescuedProps: input.rescuedProps,
			sharedProps: union(input.sharedProps, sharedData.keys),
			onceProps: { ...input.onceProps, ...sharedData.onceProps },
			flash: input.flash as Record<string, unknown> | undefined,
			// #1013 — input wins (an explicit `false` opts out), then the request
			// mark, then the adapter default.
			encryptHistory: resolveEncryptHistory(ctx, input.encryptHistory),
			clearHistory: resolveClearHistory(ctx, input.clearHistory),
			preserveFragment: input.preserveFragment,
			alwaysProps: union(input.alwaysProps, sharedData.alwaysKeys),
			exposeSharedPropKeys: input.exposeSharedPropKeys,
		});

		warnOversizedPage(ctx, page);

		// The response that CONSUMED a flash is the response that expires it: the
		// `flash` middleware step hands its clearing `Set-Cookie` here (#996).
		const cookies = input.cookies?.length ? { cookies: input.cookies } : {};

		if (isInertiaRequest(headers)) {
			return {
				[RESPOND_BRAND]: true,
				status: 200,
				contentType: "application/json",
				headers: { ...VARY, "X-Inertia": "true" },
				...cookies,
				body: page,
			};
		}

		return {
			[RESPOND_BRAND]: true,
			status: 200,
			contentType: "text/html; charset=utf-8",
			headers: { ...VARY },
			...cookies,
			body: renderShell(page, {
				shell: input.shell,
				rootId: input.rootId,
				head: input.head,
				viewData: input.viewData as Record<string, unknown> | undefined,
			}),
		};
	},
});
