/**
 * Every node the #1003 conformance fixture resolves a prop or a write with.
 *
 * ONE barrel: `discoverNodes` registers every node-shaped value of a directory's
 * default export (#360), so the whole fixture is one directory instead of
 * twenty-three. These are ordinary `defineNode()` values — the suite proves the
 * adapter, not a private test harness.
 *
 * State is in-process on purpose: the runner spawns ONE server per cell and the
 * fixture is thrown away afterwards, so a module-level array is the store.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineNode, runtimeNode } from "@blokjs/core";
import {
	cursorPaginate,
	cursorPaginatedSchema,
	flashCookie,
	location,
	logoutResponse,
	paginate,
	paginatedSchema,
	redirect,
	redirectBack,
} from "@blokjs/inertia";
import { z } from "zod";

// =============================================================================
// Data
// =============================================================================

const Order = z.object({ id: z.string(), sku: z.string(), title: z.string(), qty: z.number() });
type OrderShape = z.infer<typeof Order>;

const ORDERS: OrderShape[] = Array.from({ length: 30 }, (_, index) => ({
	id: String(index + 1),
	sku: `SKU-${index + 1}`,
	title: `Order ${index + 1}`,
	qty: index + 1,
}));

let nextOrderId = ORDERS.length;

const FEED = Array.from({ length: 40 }, (_, index) => ({ id: `f-${index + 1}`, label: `Feed ${index + 1}` }));
const USERS = Array.from({ length: 40 }, (_, index) => ({ id: `u-${index + 1}`, name: `User ${index + 1}` }));

/** The XSS payload scenarios 16 and 20 chase end to end. */
const SCRIPT_PAYLOAD = "</script><script>window.pwned=1</script> and a slash: /";

const SESSION_COOKIE = "e2e_session";

function cookies(header: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of String(header ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key) out[key] = decodeURIComponent(rest.join("="));
	}
	return out;
}

interface RequestLike {
	headers?: Record<string, unknown>;
	method?: string;
	url?: string;
	path?: string;
	query?: Record<string, string>;
}

/**
 * `redirect()` promotes only PUT/PATCH/DELETE to 303 — Inertia's documented
 * rule, and Laravel's behaviour. A redirect that answers a POST is left at 302,
 * which a browser may replay as a POST against the target. `redirectBack()`
 * already makes the stricter choice for a failed write; these routes make the
 * same one for a successful one, so no fixture write is ever replayable.
 */
function seeOther<T extends { status?: number }>(env: T, method: string): T {
	const write = method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD";
	return env.status === 302 && write ? { ...env, status: 303 } : env;
}

/** A redirect that also carries flash data — `redirectBack()`'s fixed-target twin. */
function redirectWithFlash(url: string, method: string, data: Record<string, unknown>) {
	const env = seeOther(redirect(url, { method }), method);
	const cookie = flashCookie({ flash: data });
	return cookie ? { ...env, cookies: [...(env.cookies ?? []), cookie] } : env;
}

/** Request headers, lower-cased — the shape every helper below reads. */
function lowerHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (value !== undefined && value !== null) out[key.toLowerCase()] = String(value);
	}
	return out;
}

function withoutReferer(headers: Record<string, string>): Record<string, string> {
	const { referer, referrer, ...rest } = headers;
	return rest;
}

function session(req: RequestLike | undefined): { id: string; email: string } {
	const email = cookies(req?.headers?.cookie)[SESSION_COOKIE] ?? "";
	return email === "" ? { id: "", email: "" } : { id: `u-${email}`, email };
}

// =============================================================================
// Shared / page props
// =============================================================================

/**
 * Who is signed in. `inertia.shared` runs this into `ctx.state.auth`, which
 * `inertia.auth` gates on (scenario 12), and pages declare it with `always()`
 * so `props.auth.email` is on the wire (scenario 13).
 */
const currentUser = defineNode({
	name: "current-user",
	description: "Resolve the signed-in user from the request cookies.",
	input: z.object({ headers: z.record(z.string()).optional() }),
	output: z.object({ id: z.string(), email: z.string() }),
	// `inertia.shared` passes the headers explicitly; a page prop declared with
	// `always(currentUser)` passes no inputs at all, so the live request is the
	// fallback — otherwise the same node answers "guest" to the page it renders.
	execute: (ctx, input) => session({ headers: input.headers ?? (ctx.request as RequestLike | undefined)?.headers }),
});

const homeCopy = defineNode({
	name: "e2e-home",
	description: "Home page copy, including the script payload the escaping scenarios chase.",
	input: z.object({}),
	output: z.object({ title: z.string(), body: z.string(), payload: z.string() }),
	execute: () => ({ title: "Home", body: "Blok speaks Inertia.", payload: SCRIPT_PAYLOAD }),
});

/**
 * The orders list. `page` grows it ten at a time (scenario 22's "Load more");
 * `bump` returns ONE existing id with a changed title, so `matchOn: "id"` has
 * something to replace in place instead of appending a duplicate.
 */
const listOrders = defineNode({
	name: "e2e-orders",
	description: "One page of orders, shaped for a merge() prop.",
	input: z.object({ page: z.string().optional(), bump: z.string().optional() }),
	output: z.object({ data: z.array(Order), total: z.number() }),
	execute: (_ctx, input) => {
		if (input.bump) {
			const target = ORDERS.find((order) => order.id === input.bump);
			return { data: target ? [{ ...target, title: `${target.title} (updated)` }] : [], total: ORDERS.length };
		}
		const page = Math.max(1, Number(input.page ?? "1") || 1);
		return { data: ORDERS.slice((page - 1) * 10, page * 10), total: ORDERS.length };
	},
});

const showOrder = defineNode({
	name: "e2e-order",
	description: "One order by id.",
	input: z.object({ id: z.string() }),
	output: Order,
	execute: (_ctx, input) => ORDERS.find((order) => order.id === input.id) ?? ORDERS[0],
});

const loadFilters = defineNode({
	name: "e2e-filters",
	description: "An optional() prop: absent until the client asks for it by name.",
	input: z.object({}),
	output: z.object({ status: z.string() }),
	execute: () => ({ status: "all" }),
});

const loadPlans = defineNode({
	name: "e2e-plans",
	description: "A once() prop: resolved once, then replayed from the client's cache.",
	input: z.object({}),
	output: z.array(z.object({ id: z.string(), price: z.number() })),
	execute: () => [
		{ id: "free", price: 0 },
		{ id: "pro", price: 20 },
	],
});

const listFeed = defineNode({
	name: "e2e-feed",
	description: "A scroll() prop on its own page parameter.",
	input: z.object({ page: z.string().optional() }),
	output: paginatedSchema(z.object({ id: z.string(), label: z.string() })),
	execute: (_ctx, input) => paginate(FEED, { page: input.page ?? 1, perPage: 10 }),
});

const listUsers = defineNode({
	name: "e2e-users",
	description: "A second scroll() prop, cursor-paginated on ?users= (scenario 23).",
	input: z.object({ cursor: z.string().optional() }),
	output: cursorPaginatedSchema(z.object({ id: z.string(), name: z.string() })),
	execute: (_ctx, input) => {
		const from = Number(input.cursor ?? "0") || 0;
		return cursorPaginate(USERS.slice(from, from + 10), {
			cursor: input.cursor ?? null,
			next: from + 10 < USERS.length ? String(from + 10) : null,
			prev: null,
			pageName: "users",
		});
	},
});

const whenVisible = defineNode({
	name: "e2e-visible",
	description: "An optional() prop <WhenVisible> fetches when it scrolls into view (scenario 39).",
	input: z.object({}),
	output: z.object({ seen: z.boolean() }),
	execute: () => ({ seen: true }),
});

/** The cross-runtime prop: `runtimes/python3/nodes/dashboard_stats/node.py`. */
const dashboardStats = runtimeNode<{ since: string }, { revenue: number; orders: number; calls: number }>(
	"dashboard-stats",
	"runtime.python3",
);

/** The second deferred group (scenario 26) — a different group means a second request. */
const secondaryStats = defineNode({
	name: "e2e-secondary",
	description: "A deferred prop in its own group, so two groups produce two parallel requests.",
	input: z.object({}),
	output: z.object({ label: z.string() }),
	execute: () => ({ label: "secondary group" }),
});

/**
 * Fails on a normal load and succeeds when the client RETRIES it: `rescue: true`
 * turns the failure into the `<Deferred rescue>` slot, and the Retry button's
 * `router.reload({ only: ["flaky"], data: { retry: "1" } })` gets the value
 * (scenario 26). Keyed on an input rather than a call counter so the outcome is
 * the same however many times the suite has already visited the page.
 */
const flakyStats = defineNode({
	name: "e2e-flaky",
	description: "A rescued deferred prop: fails on load, succeeds when retried.",
	input: z.object({ retry: z.string().optional() }),
	output: z.object({ label: z.string() }),
	execute: (_ctx, input) => {
		if (!input.retry) throw new Error("e2e: the flaky prop failed on purpose");
		return { label: "rescued and retried" };
	},
});

// =============================================================================
// Writes
// =============================================================================

const createOrder = defineNode({
	name: "e2e-create-order",
	description: "Persist an order, flash a toast and redirect to the list.",
	input: z.object({ sku: z.string(), qty: z.number() }),
	output: z.unknown(),
	execute: (ctx, input) => {
		// To the FRONT, so the redirect back to page 1 actually shows it — and on
		// a monotonic id, so a delete can never make two orders share one.
		nextOrderId += 1;
		ORDERS.unshift({ id: String(nextOrderId), sku: input.sku, title: `Order ${input.sku}`, qty: input.qty });
		const method = String((ctx.request as RequestLike | undefined)?.method ?? "POST");
		return redirectWithFlash("/orders", method, { toast: `${input.sku} created.` });
	},
});

const rejectSubmission = defineNode({
	name: "e2e-reject",
	description: "Redirect back carrying validation errors (and the error bag, when one was sent).",
	input: z.object({ errors: z.record(z.unknown()), fallback: z.string() }),
	output: z.unknown(),
	// The error BAG is not passed here on purpose: `redirectBack()` already
	// defaults it to the request's own `X-Inertia-Error-Bag`, which is what
	// keeps two same-named forms on one page independent (scenario 28).
	execute: (ctx, input) => {
		const req = ctx.request as RequestLike;
		const headers = lowerHeaders(req?.headers);
		// A CROSS-ORIGIN XHR's `Referer` is cut down to the bare origin by the
		// browser's default referrer policy (`strict-origin-when-cross-origin`),
		// so in standalone mode it names no page — only "somewhere on that site".
		// An app that serves both deployment modes therefore has to name its own
		// bounce target; hiding the useless Referer is how it does that here.
		const referer = headers.referer ?? headers.referrer ?? "";
		const namesAPage = referer !== "" && new URL(referer, "http://blok.invalid").pathname !== "/";
		const request = namesAPage ? req : { ...req, headers: withoutReferer(headers) };
		return redirectBack(request as never, { errors: input.errors, fallback: input.fallback });
	},
});

const deleteOrder = defineNode({
	name: "e2e-delete-order",
	description: "Remove an order and 303 back to the list.",
	input: z.object({ id: z.string() }),
	output: z.unknown(),
	execute: (ctx, input) => {
		const index = ORDERS.findIndex((order) => order.id === input.id);
		if (index >= 0) ORDERS.splice(index, 1);
		return redirect("/orders", { method: String((ctx.request as RequestLike | undefined)?.method ?? "DELETE") });
	},
});

const uploadProof = defineNode({
	name: "e2e-upload",
	description: "Accept a spoofed PUT multipart upload and report what arrived.",
	input: z.object({ sku: z.string().optional(), proof: z.unknown().optional() }),
	output: z.unknown(),
	execute: (ctx, input) => {
		// The parser hands back a `File` (or a disk-spooled stand-in) — the name
		// is `File.name`, not the raw part's `filename` attribute.
		const file = input.proof as { name?: unknown; filename?: unknown } | null;
		const name =
			typeof file === "object" && file !== null
				? String(file.name ?? file.filename ?? "file")
				: String(input.proof ?? "none");
		const method = String((ctx.request as RequestLike | undefined)?.method ?? "PUT");
		return redirectWithFlash("/orders/create", method, { toast: `uploaded ${name}` });
	},
});

const logIn = defineNode({
	name: "e2e-login",
	description: "Set the session cookie and redirect to the intended page.",
	input: z.object({ email: z.string(), to: z.string().optional() }),
	output: z.unknown(),
	execute: (ctx, input) => {
		const method = String((ctx.request as RequestLike | undefined)?.method ?? "POST");
		const env = seeOther(redirect(input.to && input.to !== "" ? input.to : "/secret", { method }), method);
		return {
			...env,
			cookies: [
				...((env as { cookies?: string[] }).cookies ?? []),
				`${SESSION_COOKIE}=${encodeURIComponent(input.email)}; Path=/; SameSite=Lax`,
			],
		};
	},
});

const logOut = defineNode({
	name: "e2e-logout",
	description: "Clear the session cookie and the client's history state.",
	input: z.object({}),
	output: z.unknown(),
	execute: (ctx) => {
		const env = logoutResponse(ctx, { redirectTo: "/login" });
		return { ...env, cookies: [...(env.cookies ?? []), `${SESSION_COOKIE}=; Path=/; Max-Age=0`] };
	},
});

// =============================================================================
// E2E control surface — real side effects, no test hooks in the adapter
// =============================================================================

/**
 * Publish a new asset version the way a deploy does: rewrite
 * `<BLOK_STATIC_DIR>/.blok-asset-version`. `assetVersion()` keys its cache on
 * the file's mtime, so the very next page object carries the new version and
 * the open client's next GET gets the 409 (scenarios 10, 11, 42).
 */
const bumpVersion = defineNode({
	name: "e2e-bump-version",
	description: "Rewrite the client build's asset-version file, as a deploy would.",
	input: z.object({}),
	output: z.object({ version: z.string() }),
	execute: () => {
		const file = join(process.env.BLOK_STATIC_DIR ?? "client/dist", ".blok-asset-version");
		const version = `e2e-${Date.now()}`;
		writeFileSync(file, version);
		return { version };
	},
});

/**
 * How many times the PYTHON node has actually run. The sidecar is a separate
 * process, so it counts in a file and this node reads it: scenario 8 asserts
 * server-side that `stats` resolved exactly once, and only in the deferred
 * follow-up request.
 */
const pythonCalls = defineNode({
	name: "e2e-python-calls",
	description: "Read the runtime.python3 node's own call counter.",
	input: z.object({}),
	output: z.object({ calls: z.number() }),
	execute: () => {
		const file = process.env.BLOK_E2E_PY_COUNTER;
		try {
			return { calls: file ? Number(readFileSync(file, "utf8").trim()) || 0 : 0 };
		} catch {
			return { calls: 0 };
		}
	},
});

const boom = defineNode({
	name: "e2e-boom",
	description: "Throw, so the production error page (or the dev modal) is exercised.",
	input: z.object({}),
	output: z.unknown(),
	execute: () => {
		throw new Error("e2e: deliberate failure");
	},
});

const externalRedirect = defineNode({
	name: "e2e-external",
	description: "409 + X-Inertia-Location: leave the app entirely.",
	input: z.object({}),
	output: z.unknown(),
	execute: () => location("https://example.org/"),
});

const fragmentRedirect = defineNode({
	name: "e2e-fragment",
	description: "409 + X-Inertia-Redirect: land on /orders#c with the fragment intact.",
	input: z.object({}),
	output: z.unknown(),
	execute: () => redirect("/orders#c"),
});

export default {
	boom,
	bumpVersion,
	createOrder,
	currentUser,
	dashboardStats,
	deleteOrder,
	externalRedirect,
	flakyStats,
	fragmentRedirect,
	homeCopy,
	listFeed,
	listOrders,
	listUsers,
	loadFilters,
	loadPlans,
	logIn,
	logOut,
	pythonCalls,
	rejectSubmission,
	secondaryStats,
	showOrder,
	uploadProof,
	whenVisible,
};

export {
	boom,
	bumpVersion,
	createOrder,
	currentUser,
	dashboardStats,
	deleteOrder,
	externalRedirect,
	flakyStats,
	fragmentRedirect,
	homeCopy,
	listFeed,
	listOrders,
	listUsers,
	loadFilters,
	loadPlans,
	logIn,
	logOut,
	pythonCalls,
	rejectSubmission,
	secondaryStats,
	showOrder,
	uploadProof,
	whenVisible,
};
