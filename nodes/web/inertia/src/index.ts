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
import { buildPage, isInertiaRequest } from "./page.js";
import { type PageObject, location, normalizeHeaders, redirect, renderShell, versionConflict } from "./protocol.js";

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
		.record(z.object({ prop: z.string(), expiresAt: z.string().nullable().optional() }))
		.optional()
		.describe("Cache key -> { prop, expiresAt }. expiresAt is null when the entry never expires."),
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
		const url = toRelativeUrl(rawUrl);
		const version = input.version ?? "";

		// --- control responses come before any page work ---
		if (input.location !== undefined) return location(input.location);
		if (input.redirect !== undefined) {
			return redirect(input.redirect, { method, prefetch, preserveFragment: input.preserveFragment });
		}

		if (!input.component) {
			throw new Error("@blokjs/inertia: `component` is required unless `redirect` or `location` is set.");
		}

		// Asset-version mismatch: only ever on a GET (a non-GET would lose the
		// body if the client replayed it as a fresh visit).
		const clientVersion = headers["x-inertia-version"];
		if (isInertiaRequest(headers) && method === "GET" && clientVersion !== undefined && clientVersion !== version) {
			// TODO(#996): re-flash session flash data here so it survives the
			// follow-up visit the client makes after this 409.
			return versionConflict(url, version);
		}

		const page: PageObject = buildPage({
			component: input.component,
			props: (input.props as Record<string, unknown> | undefined) ?? {},
			url,
			version,
			errors: input.errors as Record<string, unknown> | undefined,
			errorBag: headers["x-inertia-error-bag"],
			headers,
			mergeProps: input.mergeProps,
			prependProps: input.prependProps,
			deepMergeProps: input.deepMergeProps,
			matchPropsOn: input.matchPropsOn,
			scrollProps: input.scrollProps,
			deferredProps: input.deferredProps,
			rescuedProps: input.rescuedProps,
			sharedProps: input.sharedProps,
			onceProps: input.onceProps,
			flash: input.flash as Record<string, unknown> | undefined,
			encryptHistory: input.encryptHistory,
			clearHistory: input.clearHistory,
			preserveFragment: input.preserveFragment,
			alwaysProps: input.alwaysProps,
			exposeSharedPropKeys: input.exposeSharedPropKeys,
		});

		if (isInertiaRequest(headers)) {
			return {
				[RESPOND_BRAND]: true,
				status: 200,
				contentType: "application/json",
				headers: { ...VARY, "X-Inertia": "true" },
				body: page,
			};
		}

		return {
			[RESPOND_BRAND]: true,
			status: 200,
			contentType: "text/html; charset=utf-8",
			headers: { ...VARY },
			body: renderShell(page, {
				shell: input.shell,
				rootId: input.rootId,
				head: input.head,
				viewData: input.viewData as Record<string, unknown> | undefined,
			}),
		};
	},
});
