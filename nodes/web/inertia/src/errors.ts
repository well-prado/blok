/**
 * Production error pages, rendered as Inertia responses — issue #1014.
 *
 * https://inertiajs.com/docs/v3/advanced/error-handling
 *
 * ## Why this exists
 *
 * In DEVELOPMENT the trigger's own error bodies (JSON diagnostics, the route
 * table, a stack) are the point: the stock client shows any NON-Inertia
 * response in its error modal, which is exactly the dev experience Inertia
 * documents. Nothing here runs there.
 *
 * In PRODUCTION that modal is the wrong answer — a 404 should be a page. An
 * Inertia response carrying a real 4xx/5xx status is what the client's own
 * `isHttpException()` path handles: it fires `inertia:httpException` and then
 * swaps the page in place, so the error renders as a normal page, the URL
 * updates and Back works.
 *
 * ## Wiring
 *
 * The HTTP trigger calls exactly one function — {@link renderErrorPage} —
 * through an optional dynamic import, so a project without `@blokjs/inertia`
 * installed boots and errors exactly as before.
 *
 * ```ts
 * configureErrorPages({
 *   pages: { 404: "Errors/NotFound", default: "Errors/Error" },
 *   statuses: [403, 404, 500, 503],
 * });
 *
 * handleExceptionsUsing(({ status, error, request }) =>
 *   status === 503 ? render("Errors/Maintenance", { until: "10:00" }) : null,
 * );
 * ```
 *
 * A handler returning `null` falls through to the trigger's own response — it
 * is the per-status opt-out, not a request for the default component.
 */

import { type RespondEnvelope, isRespondEnvelope } from "@blokjs/shared";
// The serializer itself renders the page: shared data, `resolveUrlUsing`,
// `transformComponentUsing`, the shell and the JSON/HTML split all live there,
// and an error page must not drift from an ordinary one. The cycle
// (index -> errors -> index) is safe because the binding is only READ inside
// these functions, long after both modules finish evaluating.
import InertiaNode from "./index.js";
import { normalizeHeaders } from "./protocol.js";

// =============================================================================
// Configuration
// =============================================================================

/** The adapter's `errorPages` option block. */
export interface ErrorPageOptions {
	/** Force error pages on/off. Default: production only (see {@link errorPagesEnabled}). */
	enabled?: boolean;
	/** Status -> component name, plus an optional `default`. Default: `Errors/Error` for all. */
	pages?: Record<string | number, string>;
	/** Statuses rendered as pages. Default `[403, 404, 500, 503]`. */
	statuses?: number[];
	/** Asset version for the error page. Default: the version the client sent, else `""`. */
	version?: string;
	/** HTML shell for the non-Inertia (first-load) error response. */
	shell?: string;
	/** Root element id / `data-page` value. */
	rootId?: string;
	/** Markup injected at the shell's head marker. */
	head?: string;
	/** Shell-template values (`{{key}}`). NEVER sent to the client. */
	viewData?: Record<string, unknown>;
}

const DEFAULT_STATUSES = [403, 404, 500, 503];
const DEFAULT_COMPONENT = "Errors/Error";

/**
 * The `message` prop: the status's standard reason phrase, NEVER the thrown
 * error's own message. A production error body is exactly where a driver
 * message, a file path or a query leaks; the hook is there for an app that
 * wants to say more, with what it knows is safe to say.
 */
const REASON: Record<number, string> = {
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	419: "Page Expired",
	429: "Too Many Requests",
	500: "Server Error",
	503: "Service Unavailable",
};

let options: ErrorPageOptions = {};

/** Set the app-wide error-page options. Merges with what is already configured. */
export function configureErrorPages(next: ErrorPageOptions): void {
	options = { ...options, ...next };
}

/**
 * Are error pages on?
 *
 * `enabled` wins; then `BLOK_INERTIA_ERROR_PAGES` (`1`/`true` on, anything else
 * off — so a production deploy can opt back out); otherwise production only.
 */
function errorPagesEnabled(): boolean {
	if (options.enabled !== undefined) return options.enabled;
	const flag = process.env.BLOK_INERTIA_ERROR_PAGES;
	if (flag !== undefined && flag !== "") return flag === "1" || flag.toLowerCase() === "true";
	return process.env.NODE_ENV === "production";
}

// =============================================================================
// The exception hook
// =============================================================================

/** What a page-rendering decision looks like — see {@link render}. */
export interface ErrorPageRender {
	component: string;
	props?: Record<string, unknown>;
}

/** What the hook is told about the failure. */
export interface ExceptionInfo {
	/** The HTTP status the trigger is about to emit. */
	status: number;
	/** The thrown value. A `GlobalError` here carries `context.code` / `context.json`. */
	error: unknown;
	/** The request surface (`headers`, `method`, `path`, `url`, `query`, `params`). */
	request: unknown;
}

/** Decide what to render for a failure, or `null` to keep the trigger's own response. */
export type ExceptionHandler = (
	info: ExceptionInfo,
) => ErrorPageRender | null | undefined | Promise<ErrorPageRender | null | undefined>;

let handler: ExceptionHandler | undefined;

/**
 * Render error responses with `fn` instead of the configured status -> component
 * map. `handleExceptionsUsing(null)` restores the default.
 *
 * The handler sees EVERY status (not just the configured ones), so it can add
 * pages the default map does not carry; returning `null` for a status leaves
 * that status to the trigger.
 */
export function handleExceptionsUsing(fn: ExceptionHandler | null): void {
	handler = fn ?? undefined;
}

/** The hook's return value: render `component` with `props`. */
export function render(component: string, props: Record<string, unknown> = {}): ErrorPageRender {
	return { component, props };
}

/** Drop the error-page options AND the exception hook. Test-only. */
export function _resetErrorPages(): void {
	options = {};
	handler = undefined;
}

// =============================================================================
// Rendering
// =============================================================================

/** The request surface the error path hands this module. */
export interface ErrorPageRequest {
	headers?: Record<string, unknown>;
	method?: string;
	url?: string;
	path?: string;
	[key: string]: unknown;
}

/**
 * Would this client understand a page? An Inertia visit always would; a plain
 * browser navigation asks for HTML. Anything else — an API client, a `fetch`
 * asking for JSON — keeps the trigger's JSON body, which is what it came for.
 */
function wantsErrorPage(headers: Record<string, string>): boolean {
	if (headers["x-inertia"] === "true") return true;
	return (headers.accept ?? "").includes("text/html");
}

/** The component the default map renders for `status`, or `null` for "not ours". */
function defaultComponent(status: number): string | null {
	// Naming a status in `pages` opts it in, whatever `statuses` says (object
	// keys are strings either way, so `{ 404: … }` and `{ "404": … }` are one
	// entry). Otherwise `statuses` is the gate and `default` the mapping.
	const named = options.pages?.[status];
	if (named !== undefined) return named;
	if (!(options.statuses ?? DEFAULT_STATUSES).includes(status)) return null;
	return options.pages?.default ?? DEFAULT_COMPONENT;
}

/**
 * Render `status` as an Inertia page response, or `null` to leave the response
 * to the caller.
 *
 * THE trigger entry point: `triggers/http` imports this one function through an
 * optional dynamic import. Throws only if the serializer itself does (a shell
 * missing its marker, a shared resolver blowing up) — the trigger treats that
 * as "no page" and emits its own body.
 */
export async function renderErrorPage(
	request: unknown,
	status: number,
	error?: unknown,
): Promise<RespondEnvelope | null> {
	if (!errorPagesEnabled()) return null;

	const req = (request ?? {}) as ErrorPageRequest;
	const headers = normalizeHeaders(req.headers);
	if (!wantsErrorPage(headers)) return null;

	const fallback = defaultComponent(status);
	const decision: ErrorPageRender | null | undefined = handler
		? await handler({ status, error, request })
		: fallback === null
			? null
			: { component: fallback };
	if (!decision?.component) return null;

	// The client's asset version rides through untouched, and the version-check
	// branch of the serializer is taken out of play: a 409 "your assets are
	// stale" would replace the error page with a reload of the URL that just
	// failed.
	const { "x-inertia-version": clientVersion, ...pageHeaders } = headers;

	const result = (await InertiaNode.handle(
		{ request: req } as never,
		{
			component: decision.component,
			props: { status, message: REASON[status] ?? "Error", ...decision.props },
			url: req.url ?? req.path ?? "/",
			version: options.version ?? clientVersion ?? "",
			headers: pageHeaders,
			method: req.method,
			shell: options.shell,
			rootId: options.rootId,
			head: options.head,
			viewData: options.viewData,
		} as never,
	)) as { data?: unknown; error?: unknown };

	if (result.error) throw result.error;
	if (!isRespondEnvelope(result.data)) return null;
	// The serializer always says 200 — a page is a page. The REAL status is what
	// makes this an error response, and what the client's `isHttpException()`
	// path keys on.
	return { ...result.data, status };
}
