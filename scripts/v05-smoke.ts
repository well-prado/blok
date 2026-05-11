/**
 * v0.5 smoke gate — boots `bun run http:dev`, waits for /health-check, then
 * curls every `triggers/http/workflows/json/v05-*.json` workflow with a
 * representative request and asserts the response shape (status code +
 * structural predicate over the JSON body). Exits non-zero on any failure.
 *
 * Wired in package.json as `bun run v05:smoke`. Designed as the merge gate
 * for any future v0.5 work — must stay <60s and green on a clean checkout.
 *
 * Usage:
 *   bun run v05:smoke              # default port 4000, 60s server boot budget
 *   BLOK_SMOKE_PORT=4100 bun run v05:smoke
 *   BLOK_SMOKE_BOOT_MS=120000 bun run v05:smoke   # bump if cold starts are slow
 *
 * External fixtures used by the workflows themselves: httpbin.org (echo +
 * status codes). No auth keys, no rate-limited endpoints. If httpbin.org is
 * down the smoke fails — that is the correct behaviour, since the example
 * workflows shipped in `triggers/http/workflows/json/` rely on it too.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import { SignJWT } from "jose";

// =============================================================================
// Configuration
// =============================================================================

const PORT = Number(process.env.BLOK_SMOKE_PORT ?? "4000");
const BASE = `http://localhost:${PORT}`;
const BOOT_TIMEOUT_MS = Number(process.env.BLOK_SMOKE_BOOT_MS ?? "60000");
const REQUEST_TIMEOUT_MS = Number(process.env.BLOK_SMOKE_REQ_MS ?? "20000");
const REPO_ROOT = path.resolve(import.meta.dir, "..");

// JWT smoke-test config — these env vars get propagated to the spawned
// http:dev so jwt-auth resolves them at request time. Production deployments
// never set these in the shell — they come from a secret manager.
const JWT_SECRET = "smoke-test-secret-12345";
const JWT_ISSUER = "https://smoke.test.example.com";
const JWT_AUDIENCE = "v05-smoke-api";

// GitHub webhook smoke config — same propagation, used by the
// github-webhook-verify middleware in `v05-github-webhook-router`. The
// byte-exact rawBody-match cases below compute the signature over the
// EXACT wire bytes a smoke case sends, which proves HttpTrigger is
// surfacing `ctx.request.rawBody` correctly (pre-v0.6 the helper signed
// JSON.stringify(parsed_body), which would silently re-serialize and
// lose any non-canonical whitespace).
const GITHUB_WEBHOOK_SECRET = "smoke-github-webhook-secret-67890";

async function mintJwt(
	claims: Record<string, unknown>,
	overrides: { issuer?: string; audience?: string; expSeconds?: number; secret?: string } = {},
): Promise<string> {
	const key = new TextEncoder().encode(overrides.secret ?? JWT_SECRET);
	let token = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
	token = token.setIssuer(overrides.issuer ?? JWT_ISSUER);
	token = token.setAudience(overrides.audience ?? JWT_AUDIENCE);
	if (overrides.expSeconds !== undefined) {
		token = token.setExpirationTime(overrides.expSeconds);
	} else {
		token = token.setExpirationTime("1h");
	}
	return token.sign(key);
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

interface SmokeCase {
	name: string;
	method: string;
	pathname: string;
	headers?: Record<string, string>;
	body?: JsonValue;
	/**
	 * Raw string body. When set, overrides `body` — the smoke runner
	 * sends `rawBody` verbatim instead of `JSON.stringify(body)`. Use
	 * for byte-exact webhook signature tests (Stripe, byte-exact GitHub)
	 * where the wire bytes must match what the sender signed.
	 */
	rawBody?: string;
	expectStatus: number;
	assert?: (body: JsonValue) => void;
}

// =============================================================================
// Test matrix — every v05-* workflow gets at least one row. Multi-path
// workflows (success + failure) get one row per path so the predicates
// stay simple and the failure point is obvious.
// =============================================================================

const cases: SmokeCase[] = [
	// --- v05-webhook-fanout: forEach parallel ----------------------------------
	{
		name: "v05-webhook-fanout — 3 subscribers fan out in parallel",
		method: "POST",
		pathname: "/v05-webhook-fanout",
		body: {
			event: { id: "evt-smoke-1", type: "test" },
			subscribers: [
				{ id: "s1", url: "https://httpbin.org/status/200" },
				{ id: "s2", url: "https://httpbin.org/status/200" },
				{ id: "s3", url: "https://httpbin.org/status/200" },
			],
		},
		expectStatus: 200,
		assert: (body) => {
			expect(body, "object", "fanout response is not an object");
			const obj = body as Record<string, JsonValue>;
			if (obj.eventId !== "evt-smoke-1") throw fail("eventId mismatch", obj);
			if (obj.dispatched !== 3) throw fail("dispatched should be 3", obj);
			if (!Array.isArray(obj.subscriberIds) || obj.subscriberIds.length !== 3)
				throw fail("subscriberIds shape wrong", obj);
		},
	},
	{
		name: "v05-webhook-fanout — empty subscriber list is a no-op",
		method: "POST",
		pathname: "/v05-webhook-fanout",
		body: { event: { id: "evt-smoke-empty" }, subscribers: [] },
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.dispatched !== 0) throw fail("dispatched should be 0", obj);
		},
	},

	// --- v05-event-router: switchOn -------------------------------------------
	{
		name: "v05-event-router — literal case (ping)",
		method: "POST",
		pathname: "/v05-event-router",
		body: { event: "ping", payload: { hello: "world" } },
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.routedAs !== "ping") throw fail("routedAs should be 'ping'", obj);
		},
	},
	{
		name: "v05-event-router — array case (order.created)",
		method: "POST",
		pathname: "/v05-event-router",
		body: { event: "order.created", payload: { orderId: "o-1" } },
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.routedAs !== "order-family") throw fail("routedAs should be 'order-family'", obj);
		},
	},
	{
		name: "v05-event-router — default fallback",
		method: "POST",
		pathname: "/v05-event-router",
		body: { event: "totally.unknown", payload: {} },
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.routedAs !== "unknown") throw fail("routedAs should be 'unknown'", obj);
		},
	},

	// --- v05-saga: tryCatch with all three arms -------------------------------
	{
		name: "v05-saga — happy path (try → finally, catch skipped)",
		method: "POST",
		pathname: "/v05-saga",
		body: { user: "alice", middleUrl: "https://httpbin.org/post" },
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.outcome !== "success") throw fail("outcome should be 'success'", obj);
			if (obj.rollbackRan !== false) throw fail("rollbackRan should be false", obj);
			if (obj.metricRan !== true) throw fail("metricRan should be true", obj);
		},
	},
	{
		name: "v05-saga — failure path (try fails → catch fires → finally still runs)",
		method: "POST",
		pathname: "/v05-saga",
		body: { user: "alice", middleUrl: "https://httpbin.org/status/500" },
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.outcome !== "failed") throw fail("outcome should be 'failed'", obj);
			if (obj.rollbackRan !== true) throw fail("rollbackRan should be true", obj);
			if (obj.metricRan !== true) throw fail("metricRan should be true", obj);
		},
	},

	// --- v05-protected: middleware chain (auth + rate-limit) ------------------
	{
		name: "v05-protected — missing auth → 401",
		method: "POST",
		pathname: "/v05-protected",
		body: { hello: "world" },
		expectStatus: 401,
	},
	{
		name: "v05-protected — matching auth → 200",
		method: "POST",
		pathname: "/v05-protected",
		headers: {
			Authorization: "Bearer smoke-token",
			"X-Expected-Token": "smoke-token",
		},
		body: { hello: "world" },
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.ok !== true) throw fail("ok should be true", obj);
			if (typeof obj.identity !== "object" || obj.identity === null) throw fail("identity should be an object", obj);
		},
	},

	// --- v05-order-fulfillment: switch + forEach + tryCatch + middleware ------
	{
		name: "v05-order-fulfillment — physical order, all items succeed",
		method: "POST",
		pathname: "/v05-order-fulfillment",
		headers: {
			Authorization: "Bearer smoke-token",
			"X-Expected-Token": "smoke-token",
		},
		body: {
			id: "ord-smoke-1",
			type: "physical",
			currency: "USD",
			total: 4200,
			items: [
				{ sku: "sku-a", quantity: 1 },
				{ sku: "sku-b", quantity: 2 },
			],
			paymentUrl: "https://httpbin.org/post",
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.outcome !== "success") throw fail("outcome should be 'success'", obj);
			if (obj.itemsProcessed !== 2) throw fail("itemsProcessed should be 2", obj);
		},
	},
	{
		name: "v05-order-fulfillment — digital order skips inventory",
		method: "POST",
		pathname: "/v05-order-fulfillment",
		headers: {
			Authorization: "Bearer smoke-token",
			"X-Expected-Token": "smoke-token",
		},
		body: {
			id: "ord-smoke-2",
			type: "digital",
			currency: "USD",
			total: 999,
			items: [{ sku: "license-pro", quantity: 1 }],
			paymentUrl: "https://httpbin.org/post",
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.outcome !== "success") throw fail("outcome should be 'success'", obj);
			if (obj.licensed !== true) throw fail("licensed should be true", obj);
		},
	},
	{
		name: "v05-order-fulfillment — payment fails → rollback path → 200 with failed outcome",
		method: "POST",
		pathname: "/v05-order-fulfillment",
		headers: {
			Authorization: "Bearer smoke-token",
			"X-Expected-Token": "smoke-token",
		},
		body: {
			id: "ord-smoke-3",
			type: "physical",
			currency: "USD",
			total: 4200,
			items: [{ sku: "sku-a", quantity: 1 }],
			paymentUrl: "https://httpbin.org/status/500",
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.outcome !== "failed") throw fail("outcome should be 'failed'", obj);
			if (typeof obj.failureReason !== "string") throw fail("failureReason should be string", obj);
		},
	},
	{
		name: "v05-order-fulfillment — missing auth → 401 from middleware",
		method: "POST",
		pathname: "/v05-order-fulfillment",
		body: {
			id: "ord-smoke-4",
			type: "physical",
			currency: "USD",
			total: 1,
			items: [],
			paymentUrl: "https://httpbin.org/post",
		},
		expectStatus: 401,
	},

	// --- v05-user-signup-saga: tryCatch with conditional rollback inside catch
	{
		name: "v05-user-signup-saga — happy path → 200 with userId",
		method: "POST",
		pathname: "/v05-user-signup-saga",
		body: {
			email: `smoke+${Date.now()}@example.com`,
			password: "hunter2",
			displayName: "Smoke Test",
			signupUrl: "https://httpbin.org/post",
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (typeof obj.userId !== "string") throw fail("userId should be string", obj);
			if (obj.outcome !== "success") throw fail("outcome should be 'success'", obj);
		},
	},
	{
		name: "v05-user-signup-saga — account-create fails → no rollback (account never created), 500",
		method: "POST",
		pathname: "/v05-user-signup-saga",
		body: {
			email: `smoke+${Date.now()}@example.com`,
			password: "hunter2",
			displayName: "Smoke Test",
			signupUrl: "https://httpbin.org/status/500",
		},
		expectStatus: 500,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.outcome !== "failed") throw fail("outcome should be 'failed'", obj);
			if (obj.rolledBack !== false) throw fail("rolledBack should be false (account never created)", obj);
		},
	},
	{
		name: "v05-user-signup-saga — profile-create fails after account-create → rollback fires, 500",
		method: "POST",
		pathname: "/v05-user-signup-saga",
		body: {
			email: `smoke+${Date.now()}@example.com`,
			password: "hunter2",
			displayName: "Smoke Test",
			signupUrl: "https://httpbin.org/post",
			profileUrl: "https://httpbin.org/status/500",
		},
		expectStatus: 500,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.outcome !== "failed") throw fail("outcome should be 'failed'", obj);
			if (obj.rolledBack !== true) throw fail("rolledBack should be true (account WAS created)", obj);
		},
	},

	// --- v05-nested-control-flow: forEach > tryCatch > switch > branch -------
	{
		name: "v05-nested-control-flow — mixed item types succeed",
		method: "POST",
		pathname: "/v05-nested-control-flow",
		headers: {
			Authorization: "Bearer smoke-token",
			"X-Expected-Token": "smoke-token",
		},
		body: {
			id: "ord-nested-1",
			items: [
				{
					sku: "phys-1",
					type: "physical",
					required: true,
					handlerUrl: "https://httpbin.org/post",
				},
				{
					sku: "dig-1",
					type: "digital",
					required: true,
					handlerUrl: "https://httpbin.org/post",
				},
			],
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.itemsProcessed !== 2) throw fail("itemsProcessed should be 2", obj);
			if (obj.failedItems !== 0) throw fail("failedItems should be 0", obj);
		},
	},
	{
		name: "v05-nested-control-flow — optional item fails → swallowed, others succeed",
		method: "POST",
		pathname: "/v05-nested-control-flow",
		headers: {
			Authorization: "Bearer smoke-token",
			"X-Expected-Token": "smoke-token",
		},
		body: {
			id: "ord-nested-2",
			items: [
				{
					sku: "phys-good",
					type: "physical",
					required: true,
					handlerUrl: "https://httpbin.org/post",
				},
				{
					sku: "phys-bad-optional",
					type: "physical",
					required: false,
					handlerUrl: "https://httpbin.org/status/500",
				},
			],
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.itemsProcessed !== 2) throw fail("itemsProcessed should be 2", obj);
			if (obj.failedItems !== 1) throw fail("failedItems should be 1 (optional swallowed)", obj);
		},
	},

	// --- v05-hello-with-mw: minimal workflow-level middleware demo -----------
	{
		name: "v05-hello-with-mw — missing auth → 401 (workflow-level middleware fires)",
		method: "GET",
		pathname: "/v05-hello-with-mw",
		expectStatus: 401,
	},
	{
		name: "v05-hello-with-mw — auth-check passes → 200 with greeting",
		method: "GET",
		pathname: "/v05-hello-with-mw",
		headers: {
			Authorization: "Bearer smoke-token",
			"X-Expected-Token": "smoke-token",
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.greeting !== "hello, world") throw fail("greeting mismatch", obj);
			if (obj.via !== "auth-check") throw fail("via should be 'auth-check'", obj);
		},
	},

	// --- v05-multi-tenant-router: switch + sub-workflow dispatch -------------
	{
		name: "v05-multi-tenant-router — tenant=acme dispatches to v05-tenant-acme",
		method: "POST",
		pathname: "/v05-multi-tenant-router",
		headers: { "X-Tenant-Id": "acme" },
		body: { order: "ord-acme-1", customer: "alice" },
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.dispatchedTo !== "dispatch-acme") throw fail("dispatchedTo should be 'dispatch-acme'", obj);
			const child = obj.child as Record<string, JsonValue> | undefined;
			if (!child || child.tenant !== "acme") throw fail("child.tenant should be 'acme'", obj);
			if (child.processedBy !== "v05-tenant-acme") throw fail("processedBy mismatch", obj);
		},
	},
	{
		name: "v05-multi-tenant-router — tenant=BETA case-insensitive routes to beta",
		method: "POST",
		pathname: "/v05-multi-tenant-router",
		headers: { "X-Tenant-Id": "BETA" },
		body: { order: "ord-beta-1" },
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			const child = obj.child as Record<string, JsonValue> | undefined;
			if (!child || child.tenant !== "beta") throw fail("child.tenant should be 'beta'", obj);
		},
	},
	{
		name: "v05-multi-tenant-router — unknown tenant → 400 with structured reason",
		method: "POST",
		pathname: "/v05-multi-tenant-router",
		headers: { "X-Tenant-Id": "unknown-corp" },
		body: {},
		expectStatus: 400,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.reason !== "tenant_not_registered") {
				throw fail("reason should be 'tenant_not_registered'", obj);
			}
		},
	},

	// --- v05-csv-import: forEach + tryCatch + DLQ ----------------------------
	{
		name: "v05-csv-import — 3 rows, 1 invalid → 2 inserted + DLQ for the bad row",
		method: "POST",
		pathname: "/v05-csv-import",
		body: {
			rows: [
				{ id: "r1", value: 100 },
				{ id: "r2", value: "not-a-number" },
				{ id: "r3", value: 200 },
			],
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.totalRows !== 3) throw fail("totalRows should be 3", obj);
			if (obj.inserted !== 2) throw fail("inserted should be 2", obj);
			const dlq = obj.dlq as Array<Record<string, JsonValue>> | undefined;
			if (!Array.isArray(dlq) || dlq.length !== 1 || dlq[0].rowId !== "r2") {
				throw fail("dlq should contain exactly r2", obj);
			}
			if (typeof dlq[0].error !== "string" || !dlq[0].error.includes("validation failed")) {
				throw fail("dlq[0].error should describe validation failure", obj);
			}
		},
	},

	// --- v05-data-export: forEach + tryCatch + retry -------------------------
	{
		name: "v05-data-export — 3 pages, 1 fails → 2 exported + 1 DLQ page",
		method: "POST",
		pathname: "/v05-data-export",
		body: {
			pages: [
				{ number: 1, url: "https://httpbin.org/get?page=1" },
				{ number: 2, url: "https://httpbin.org/get?page=2" },
				{ number: 3, url: "https://httpbin.org/status/500" },
			],
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.exported !== true) throw fail("exported should be true", obj);
			if (obj.successfulPages !== 2) throw fail("successfulPages should be 2", obj);
			const dlq = obj.dlqPages as Array<Record<string, JsonValue>> | undefined;
			if (!Array.isArray(dlq) || dlq.length !== 1 || dlq[0].page !== 3) {
				throw fail("dlqPages should contain exactly page 3", obj);
			}
		},
	},

	// --- v05-travel-booking: tryCatch with manual compensation chain ---------
	{
		name: "v05-travel-booking — happy path → all three booked",
		method: "POST",
		pathname: "/v05-travel-booking",
		body: {
			flightUrl: "https://httpbin.org/post",
			hotelUrl: "https://httpbin.org/post",
			carUrl: "https://httpbin.org/post",
			passenger: "alice",
		},
		expectStatus: 200,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.outcome !== "booked") throw fail("outcome should be 'booked'", obj);
			if (obj.flight !== true || obj.hotel !== true || obj.car !== true) {
				throw fail("flight + hotel + car should all be true", obj);
			}
		},
	},
	{
		name: "v05-travel-booking — car fails → flight + hotel compensated, 500",
		method: "POST",
		pathname: "/v05-travel-booking",
		body: {
			flightUrl: "https://httpbin.org/post",
			hotelUrl: "https://httpbin.org/post",
			carUrl: "https://httpbin.org/status/500",
			passenger: "alice",
		},
		expectStatus: 500,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.outcome !== "failed") throw fail("outcome should be 'failed'", obj);
			if (obj.failedAt !== "book-car") throw fail("failedAt should be 'book-car'", obj);
			const comp = obj.compensated as Record<string, JsonValue> | undefined;
			if (!comp || comp.flight !== true || comp.hotel !== true || comp.car !== false) {
				throw fail("compensated should be {flight:true, hotel:true, car:false}", obj);
			}
		},
	},
	{
		name: "v05-travel-booking — flight fails first → no compensation needed, 500",
		method: "POST",
		pathname: "/v05-travel-booking",
		body: {
			flightUrl: "https://httpbin.org/status/500",
			hotelUrl: "https://httpbin.org/post",
			carUrl: "https://httpbin.org/post",
		},
		expectStatus: 500,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.failedAt !== "book-flight") throw fail("failedAt should be 'book-flight'", obj);
			const comp = obj.compensated as Record<string, JsonValue> | undefined;
			if (!comp || comp.flight !== false || comp.hotel !== false || comp.car !== false) {
				throw fail("no compensations should fire when flight fails first", obj);
			}
		},
	},

	// --- v05-admin-delete-user: jwt-auth + admin-only chain ------------------
	// Note: the HAPPY-PATH case (admin-role token → 200) is covered in the
	// JWT-cases builder below since it needs a freshly minted JWT with role
	// claim. The unauth + non-admin cases live here because they don't
	// require token signing.
	{
		name: "v05-admin-delete-user — missing auth → 401 (jwt-auth fires first)",
		method: "POST",
		pathname: "/v05-admin-delete-user",
		body: { userId: "u-123" },
		expectStatus: 401,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (obj.reason !== "missing_token") throw fail("reason should be 'missing_token'", obj);
		},
	},

	// --- v05-async-job-poller: v0.6 Phase 2 — wait inside forEach iteration --
	// Sequential forEach over a list of jobs; each iteration's body has a
	// `wait.for(100ms)` after the record step. When the FIRST iteration's
	// wait fires, the runner throws WaitDispatchRequest → DeferredDispatch-
	// Signal → HTTP 202 + Location header. This is the headline contract of
	// v0.6 Phase 2: a wait inside an iteration body correctly defers
	// (rather than silently no-op'ing as it did pre-Phase 2). The full
	// round-trip across all 3 iterations (each defer + re-entry advancing
	// the cursor through `node_runs.iteration_context`) is exercised by
	// `core/runner/__tests__/unit/wait-inside-foreach.test.ts` since
	// poll-until-completed is beyond smoke's scope.
	{
		name: "v05-async-job-poller — forEach with wait inside iteration → 202 deferred",
		method: "POST",
		pathname: "/v05-async-job-poller",
		body: { jobs: ["job-A", "job-B", "job-C"] },
		expectStatus: 202,
		assert: (body) => {
			const obj = body as Record<string, JsonValue>;
			if (typeof obj.runId !== "string" || obj.runId.length === 0) {
				throw fail("runId should be a non-empty string", obj);
			}
			if (obj.status !== "delayed") {
				throw fail("status should be 'delayed' (deferred dispatch from wait inside forEach)", obj);
			}
		},
	},
];

// --- v05-github-webhook-router: byte-exact HMAC against ctx.request.rawBody
// v0.6 — github-webhook-verify now signs `ctx.request.rawBody` instead of
// `JSON.stringify(ctx.request.body)`. These cases prove the raw-body capture
// works end-to-end through HttpTrigger.parseBody.
//
// 1. Positive — raw body with NON-CANONICAL whitespace (`{ "repo" :  …}` with
//    spaces JSON.stringify would NEVER produce). The signature is computed
//    over those exact bytes. New behaviour: matches → 200. Pre-v0.6 would
//    have signed `JSON.stringify(parsed)` (canonical, no spaces) → mismatch
//    → 401. So the positive case is the proof that the rawBody path is hot.
//
// 2. Negative — same raw body, but signature computed over the canonical
//    re-serialization. Old code would have accepted this; new code rejects.
//    Inverts the proof from the opposite direction.
//
// Appended at the end (outside the literal array) because the const-IIFE
// pattern keeps the signature-computation locals out of module scope.
const githubByteExactCases: SmokeCase[] = (() => {
	const rawBodyWithSpaces =
		'{ "ref" :  "refs/heads/main" ,  "repository" : { "full_name" : "acme/widgets" } ,  "commits" : [ { "id" : "abc123" } ] }';
	const positiveSig = `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(rawBodyWithSpaces).digest("hex")}`;
	const canonicalSig = `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET)
		.update(JSON.stringify(JSON.parse(rawBodyWithSpaces)))
		.digest("hex")}`;
	return [
		{
			name: "v05-github-webhook-router — byte-exact sig over rawBody with non-canonical whitespace → 200",
			method: "POST",
			pathname: "/v05-github-webhook-router",
			headers: {
				"X-Hub-Signature-256": positiveSig,
				"X-GitHub-Event": "push",
				"X-GitHub-Delivery": "smoke-byte-exact-1",
			},
			rawBody: rawBodyWithSpaces,
			expectStatus: 200,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.eventType !== "push") throw fail("eventType should be 'push'", obj);
				if (obj.dispatchedTo !== "dispatch-push") throw fail("dispatchedTo should be 'dispatch-push'", obj);
				const child = obj.child as Record<string, JsonValue>;
				if (!child) throw fail("child should be present (sub-workflow output)", obj);
				if (child.handler !== "push") throw fail("child.handler should be 'push'", obj);
				if (child.repo !== "acme/widgets") throw fail("child.repo should be 'acme/widgets'", obj);
				if (child.ref !== "refs/heads/main") throw fail("child.ref should be 'refs/heads/main'", obj);
			},
		},
		{
			name: "v05-github-webhook-router — sig over JSON.stringify(parsed) ≠ rawBody bytes → 401 (proves rawBody is load-bearing)",
			method: "POST",
			pathname: "/v05-github-webhook-router",
			headers: {
				"X-Hub-Signature-256": canonicalSig,
				"X-GitHub-Event": "push",
				"X-GitHub-Delivery": "smoke-byte-exact-2",
			},
			rawBody: rawBodyWithSpaces,
			expectStatus: 401,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.reason !== "invalid_signature") {
					throw fail("reason should be 'invalid_signature' (proves we're not signing JSON.stringify any more)", obj);
				}
			},
		},
	];
})();
cases.push(...githubByteExactCases);

// JWT cases live in their own builder because each case mints a token via
// jose's SignJWT (async). Appended to `cases` at runtime in main() once
// the server is ready. Keeps the static array readable and avoids a
// top-level await in this script.
async function buildJwtCases(): Promise<SmokeCase[]> {
	const validToken = await mintJwt({ sub: "alice", role: "admin", org: "acme" });
	const wrongIssuerToken = await mintJwt({ sub: "alice" }, { issuer: "https://impostor.example.com" });
	const wrongAudienceToken = await mintJwt({ sub: "alice" }, { audience: "wrong-audience" });
	const wrongSecretToken = await mintJwt({ sub: "alice" }, { secret: "wrong-secret" });
	const expiredToken = await mintJwt({ sub: "alice" }, { expSeconds: Math.floor(Date.now() / 1000) - 60 });

	return [
		{
			name: "v05-jwt-protected — missing Authorization header → 401 (missing_token)",
			method: "POST",
			pathname: "/v05-jwt-protected",
			body: { hello: "world" },
			expectStatus: 401,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.reason !== "missing_token") throw fail("reason should be 'missing_token'", obj);
			},
		},
		{
			name: "v05-jwt-protected — malformed token → 401 (malformed_token)",
			method: "POST",
			pathname: "/v05-jwt-protected",
			headers: { Authorization: "Bearer not-a-real-jwt" },
			body: {},
			expectStatus: 401,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.reason !== "malformed_token") throw fail("reason should be 'malformed_token'", obj);
			},
		},
		{
			name: "v05-jwt-protected — bad signature → 401 (invalid_signature)",
			method: "POST",
			pathname: "/v05-jwt-protected",
			headers: { Authorization: `Bearer ${wrongSecretToken}` },
			body: {},
			expectStatus: 401,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.reason !== "invalid_signature") throw fail("reason should be 'invalid_signature'", obj);
			},
		},
		{
			name: "v05-jwt-protected — expired token → 401 (token_expired)",
			method: "POST",
			pathname: "/v05-jwt-protected",
			headers: { Authorization: `Bearer ${expiredToken}` },
			body: {},
			expectStatus: 401,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.reason !== "token_expired") throw fail("reason should be 'token_expired'", obj);
			},
		},
		{
			name: "v05-jwt-protected — wrong issuer → 401 (issuer_mismatch)",
			method: "POST",
			pathname: "/v05-jwt-protected",
			headers: { Authorization: `Bearer ${wrongIssuerToken}` },
			body: {},
			expectStatus: 401,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.reason !== "issuer_mismatch") throw fail("reason should be 'issuer_mismatch'", obj);
			},
		},
		{
			name: "v05-jwt-protected — wrong audience → 401 (audience_mismatch)",
			method: "POST",
			pathname: "/v05-jwt-protected",
			headers: { Authorization: `Bearer ${wrongAudienceToken}` },
			body: {},
			expectStatus: 401,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.reason !== "audience_mismatch") throw fail("reason should be 'audience_mismatch'", obj);
			},
		},
		{
			name: "v05-jwt-protected — valid token → 200 with verified claims at ctx.state.identity",
			method: "POST",
			pathname: "/v05-jwt-protected",
			headers: { Authorization: `Bearer ${validToken}` },
			body: { hello: "world" },
			expectStatus: 200,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.ok !== true) throw fail("ok should be true", obj);
				const id = obj.identity as Record<string, JsonValue> | undefined;
				if (!id || id.sub !== "alice") throw fail("identity.sub should be 'alice'", obj);
				if (id.iss !== JWT_ISSUER) throw fail(`identity.iss should be ${JWT_ISSUER}`, obj);
				if (id.aud !== JWT_AUDIENCE) throw fail(`identity.aud should be ${JWT_AUDIENCE}`, obj);
				const custom = obj.customClaims as Record<string, JsonValue> | undefined;
				if (!custom || custom.role !== "admin" || custom.org !== "acme") {
					throw fail("customClaims should carry role + org", obj);
				}
			},
		},

		// --- v05-admin-delete-user: needs JWT with role claim, lives here
		// because token minting is async.
		{
			name: "v05-admin-delete-user — admin role → 200 (chain: jwt-auth + admin-only both pass)",
			method: "POST",
			pathname: "/v05-admin-delete-user",
			headers: { Authorization: `Bearer ${await mintJwt({ sub: "admin-user", role: "admin" })}` },
			body: { userId: "u-target-1" },
			expectStatus: 200,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.ok !== true) throw fail("ok should be true", obj);
				if (obj.targetUserId !== "u-target-1") throw fail("targetUserId mismatch", obj);
				if (obj.deletedBy !== "admin-user") throw fail("deletedBy should be 'admin-user'", obj);
			},
		},
		{
			name: "v05-admin-delete-user — non-admin role → 403 from admin-only middleware",
			method: "POST",
			pathname: "/v05-admin-delete-user",
			headers: { Authorization: `Bearer ${await mintJwt({ sub: "regular-user", role: "user" })}` },
			body: { userId: "u-target-2" },
			expectStatus: 403,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.reason !== "admin_role_required") {
					throw fail("reason should be 'admin_role_required'", obj);
				}
			},
		},
	];
}

/**
 * Redis-backed cases for v05-redis-protected. Skipped when REDIS_URL is
 * unset — the smoke gate prints a one-line skip notice and moves on. The
 * spawned http:dev inherits the same REDIS_URL so the redis-rate-limit
 * middleware connects to the same instance the smoke gate is using.
 *
 * Bucket isolation: each smoke run uses a unique JWT `sub` claim
 * (`smoke-redis-<timestamp>`) so consecutive runs against a long-lived
 * Redis don't see stale state from prior runs.
 */
async function buildRedisCases(): Promise<SmokeCase[]> {
	if (process.env.REDIS_URL === undefined) return [];
	const subject = `smoke-redis-${Date.now()}`;
	const token = await mintJwt({ sub: subject });

	// First five requests should each report count=1..5 with remaining=4..0.
	// We generate them programmatically so the assertion matches the
	// per-request expected count without copy-paste drift.
	const underLimitCases: SmokeCase[] = [];
	for (let i = 1; i <= 5; i++) {
		const expectedCount = i;
		const expectedRemaining = 5 - i;
		underLimitCases.push({
			name: `v05-redis-protected — request ${i}/5 under the limit (count=${expectedCount})`,
			method: "POST",
			pathname: "/v05-redis-protected",
			headers: { Authorization: `Bearer ${token}` },
			body: {},
			expectStatus: 200,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				const rl = obj.rateLimit as Record<string, JsonValue> | undefined;
				if (!rl || rl.count !== expectedCount) {
					throw fail(`rateLimit.count should be ${expectedCount}`, obj);
				}
				if (rl.remaining !== expectedRemaining) {
					throw fail(`rateLimit.remaining should be ${expectedRemaining}`, obj);
				}
			},
		});
	}

	return [
		{
			name: "v05-redis-protected — missing auth → 401 from jwt-auth (rate-limit never runs)",
			method: "POST",
			pathname: "/v05-redis-protected",
			body: {},
			expectStatus: 401,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.reason !== "missing_token") throw fail("reason should be 'missing_token'", obj);
			},
		},
		...underLimitCases,
		{
			name: "v05-redis-protected — 6th request hits the limit → 429 with retryAfterSec",
			method: "POST",
			pathname: "/v05-redis-protected",
			headers: { Authorization: `Bearer ${token}` },
			body: {},
			expectStatus: 429,
			assert: (body) => {
				const obj = body as Record<string, JsonValue>;
				if (obj.error !== "Rate limit exceeded") throw fail("error should be 'Rate limit exceeded'", obj);
				if (typeof obj.retryAfterSec !== "number" || obj.retryAfterSec <= 0) {
					throw fail("retryAfterSec should be a positive number", obj);
				}
			},
		},
	];
}

// =============================================================================
// Helpers
// =============================================================================

function fail(why: string, ctx: unknown): Error {
	const e = new Error(`${why} — got: ${JSON.stringify(ctx)}`);
	return e;
}

function expect(value: unknown, kind: "object" | "array", why: string): void {
	if (kind === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error(`${why} — got: ${JSON.stringify(value)}`);
		return;
	}
	if (!Array.isArray(value)) throw new Error(`${why} — got: ${JSON.stringify(value)}`);
}

async function waitForReady(deadlineAt: number): Promise<void> {
	while (Date.now() < deadlineAt) {
		try {
			const res = await fetch(`${BASE}/health-check`, {
				signal: AbortSignal.timeout(1500),
			});
			if (res.ok) return;
		} catch {
			// not yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`http:dev did not respond on ${BASE}/health-check within ${BOOT_TIMEOUT_MS}ms`);
}

async function runCase(c: SmokeCase): Promise<void> {
	// `rawBody` overrides `body` so byte-exact webhook signature cases
	// can send their exact wire bytes (no JSON.stringify re-serialize).
	const bodyToSend = c.rawBody !== undefined ? c.rawBody : c.body === undefined ? undefined : JSON.stringify(c.body);
	const res = await fetch(`${BASE}${c.pathname}`, {
		method: c.method,
		headers: {
			"Content-Type": "application/json",
			...(c.headers ?? {}),
		},
		body: bodyToSend,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (res.status !== c.expectStatus) {
		const txt = await res.text().catch(() => "<no body>");
		throw new Error(`expected status ${c.expectStatus}, got ${res.status}. body: ${txt.slice(0, 600)}`);
	}

	if (c.assert) {
		const txt = await res.text();
		let parsed: JsonValue;
		try {
			parsed = JSON.parse(txt) as JsonValue;
		} catch {
			throw new Error(`response was not valid JSON. status=${res.status} body=${txt.slice(0, 400)}`);
		}
		c.assert(parsed);
	}
}

// =============================================================================
// Main
// =============================================================================

/**
 * Pre-flight: kill any process already holding our PORT. A leftover http:dev
 * from a previous interrupted smoke run, a manual `bun run http:dev`, or
 * a half-killed dev session would otherwise look "ready" to the boot
 * detection below — and run the test cases against the wrong env (stale
 * JWT_ISSUER, missing JWT_SECRET, etc.). This was a real footgun until
 * v0.5.3 hardened it. Use lsof + kill -9 because a graceful SIGTERM gives
 * the orphan time to drop new connections but not to release the port.
 */
async function killPortHolder(port: number): Promise<void> {
	const lsof = spawn("lsof", ["-ti", `:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
	let pidsRaw = "";
	lsof.stdout?.on("data", (chunk: Buffer) => {
		pidsRaw += chunk.toString();
	});
	await new Promise<void>((resolve) => {
		lsof.on("close", () => resolve());
	});
	const pids = pidsRaw
		.split(/\s+/)
		.map((s) => Number.parseInt(s, 10))
		.filter((n) => Number.isInteger(n) && n > 0);
	if (pids.length === 0) return;
	console.log(`[v05-smoke] WARN: killing ${pids.length} orphan process(es) on port ${port}: ${pids.join(", ")}`);
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already dead
		}
	}
	// Tiny grace period so the kernel reclaims the socket before the spawn
	// below tries to bind.
	await new Promise((resolve) => setTimeout(resolve, 500));
}

async function main(): Promise<number> {
	const startedAt = Date.now();
	await killPortHolder(PORT);
	console.log(`[v05-smoke] booting bun run http:dev (PORT=${PORT}) ...`);

	const child: ChildProcess = spawn("bun", ["run", "http:dev"], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PORT: String(PORT),
			// JWT config picked up by the jwt-auth middleware.
			// Production uses real KMS / secret-manager-sourced values; this
			// is the smoke-test equivalent.
			JWT_SECRET,
			JWT_ISSUER,
			JWT_AUDIENCE,
			// GitHub webhook config picked up by github-webhook-verify
			// middleware. The byte-exact rawBody-match cases below sign
			// with this secret.
			GITHUB_WEBHOOK_SECRET,
		},
		detached: true,
	});

	let serverOut = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		serverOut += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		serverOut += chunk.toString();
	});

	const cleanup = (): void => {
		try {
			if (child.pid !== undefined) {
				process.kill(-child.pid, "SIGTERM");
			}
		} catch {
			// already gone
		}
	};
	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});

	let pass = 0;
	let fail = 0;
	const failures: { name: string; reason: string }[] = [];

	try {
		await waitForReady(Date.now() + BOOT_TIMEOUT_MS);
		// Mint JWT-bearing cases now that the server is ready. Tokens are
		// short-lived (1h default) so signing here vs at module load
		// doesn't matter — but doing it after the boot wait keeps any
		// signing failure visible right next to the rest of the smoke
		// output instead of crashing module init.
		const jwtCases = await buildJwtCases();
		cases.push(...jwtCases);

		// Redis cases are gated on REDIS_URL — if a Redis isn't reachable,
		// we silently skip rather than fail the whole smoke run. Operators
		// opt in by exporting REDIS_URL before invoking the smoke script.
		const redisCases = await buildRedisCases();
		if (redisCases.length === 0 && process.env.REDIS_URL === undefined) {
			console.log("[v05-smoke] note: REDIS_URL unset — skipping v05-redis-protected cases");
		} else {
			cases.push(...redisCases);
		}
		console.log(`[v05-smoke] server is ready (${Date.now() - startedAt}ms) — running ${cases.length} cases\n`);

		for (const c of cases) {
			const t0 = Date.now();
			try {
				await runCase(c);
				const dur = Date.now() - t0;
				console.log(`  PASS  ${c.name} (${dur}ms)`);
				pass++;
			} catch (err) {
				const reason = err instanceof Error ? err.message : JSON.stringify(err);
				console.log(`  FAIL  ${c.name}\n        ${reason}`);
				failures.push({ name: c.name, reason });
				fail++;
			}
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : JSON.stringify(err);
		console.error(`[v05-smoke] fatal: ${reason}`);
		console.error(`[v05-smoke] last 800 bytes of server output:\n${serverOut.slice(-800)}`);
		cleanup();
		return 1;
	}

	const totalMs = Date.now() - startedAt;
	console.log(`\n[v05-smoke] done in ${totalMs}ms — ${pass} passed, ${fail} failed`);
	if (fail > 0) {
		console.log("[v05-smoke] FAILURES:");
		for (const f of failures) console.log(`  - ${f.name}: ${f.reason}`);
	}

	cleanup();
	return fail === 0 ? 0 : 1;
}

const code = await main();
// Give the SIGTERM a tick to propagate before we exit; otherwise bun's --watch
// child can leak a stray runtime process on rare CI environments.
await new Promise((r) => setTimeout(r, 250));
process.exit(code);
