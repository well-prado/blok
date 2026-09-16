/**
 * #1012 — the `@blokjs/csrf` node's branches that an HTTP round trip cannot
 * reach cheaply: the `Secure` attribute behind a TLS-terminating proxy, custom
 * cookie/header names, `_method`-spoofed writes, the deeper `except` globs, and
 * the degraded bounce-back when no `BLOK_FLASH_SECRET` is configured.
 *
 * The rejection cases go through `handle()` rather than `runNode`, for the same
 * reason `flash.test.ts` does: the assertion is about the `GlobalError`
 * INSTANCE, which `runNode` re-wraps as a plain `Error`.
 */

import type { Context, GlobalError } from "@blokjs/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CsrfNode from "../src/csrf";

interface TestRequest {
	headers?: Record<string, unknown>;
	body?: unknown;
	method?: string;
	originalMethod?: string;
	path?: string;
	url?: string;
}

function ctxFor(request: TestRequest = {}): Context {
	return {
		id: "test-req",
		workflow_name: "test-wf",
		request: { body: {}, headers: {}, params: {}, query: {}, method: "GET", path: "/", ...request },
		response: { data: {}, success: true, error: null },
		error: { message: [] },
		logger: { log: vi.fn(), error: vi.fn(), logLevel: vi.fn() },
		config: {},
		state: {},
		vars: {},
		env: {},
	} as unknown as Context;
}

/** Run the node and return both the ctx (for the issued cookie) and the result. */
async function run(request: TestRequest, inputs: Record<string, unknown> = {}) {
	const ctx = ctxFor(request);
	const res = (await CsrfNode.handle(ctx, inputs)) as { data?: unknown; error?: GlobalError };
	return { ctx, res, error: res.error };
}

/** What `issueCsrfCookie` queued onto this request's response. */
function issued(ctx: Context): string[] {
	return (ctx as unknown as { _blokCsrfCookies?: string[] })._blokCsrfCookies ?? [];
}

describe("@blokjs/csrf (#1012)", () => {
	beforeEach(() => {
		process.env.BLOK_FLASH_SECRET = "unit-csrf-secret";
	});

	it("marks the cookie Secure behind a TLS-terminating proxy", async () => {
		const { ctx } = await run({ headers: { "x-forwarded-proto": "https, http" } });
		expect(issued(ctx)[0]).toContain("Secure");

		const plain = await run({ headers: {} });
		expect(issued(plain.ctx)[0]).not.toContain("Secure");
	});

	it("honours custom cookie and header names on both sides", async () => {
		const { res, ctx } = await run(
			{
				method: "POST",
				headers: { cookie: "csrf=abc123", "x-csrf": "abc123" },
			},
			{ cookieName: "csrf", headerName: "X-CSRF" },
		);
		expect((res.data as { verified: boolean }).verified).toBe(true);
		// The cookie was already there, so nothing was issued.
		expect(issued(ctx)).toEqual([]);
	});

	it("verifies a `_method`-spoofed write, not just the wire method", async () => {
		const { error } = await run({
			method: "DELETE",
			originalMethod: "POST",
			headers: { cookie: "XSRF-TOKEN=abc" },
			body: { _method: "DELETE" },
		});
		expect(error?.context.code).toBe(303);
	});

	it("exempts a nested path under an `except` glob, but not a sibling route", async () => {
		const exempt = await run({ method: "POST", path: "/webhooks/stripe/events" }, { except: ["webhooks/*"] });
		expect((exempt.res.data as { exempt: boolean }).exempt).toBe(true);

		const guarded = await run({ method: "POST", path: "/webhooks-admin" }, { except: ["webhooks/*"] });
		expect(guarded.error?.context.code).toBe(303);
	});

	it("still bounces back — without the flash — when no signing secret is configured", async () => {
		// biome-ignore lint/performance/noDelete: the env var must be ABSENT, not "undefined".
		delete process.env.BLOK_FLASH_SECRET;
		const { error } = await run({
			method: "POST",
			headers: { cookie: "XSRF-TOKEN=abc", referer: "/orders/new" },
		});
		expect(error?.context.code).toBe(303);
		expect(error?.context.headers).toEqual({ Location: "/orders/new" });
		// The request already had a token cookie, so the rejection carries no
		// cookie at all — and crucially not an unsigned flash.
		expect(error?.context.cookies ?? []).toEqual([]);
	});

	it("issues a token on the rejection itself, so the retry has one", async () => {
		const { error } = await run({ method: "POST", headers: {} });
		expect(error?.context.code).toBe(303);
		expect(error?.context.headers).toEqual({ Location: "/" });
		const cookie = error?.context.cookies?.find((c) => c.startsWith("XSRF-TOKEN="));
		expect(cookie).toBeTruthy();
		expect(cookie).toContain("SameSite=Lax");
	});

	/**
	 * #1003 — the REJECTION is the path an attacker can trigger on demand: a
	 * forged cross-site POST fails the check by construction. Bouncing to the raw
	 * `Referer` would answer it with a 303 to their own site.
	 */
	describe("the bounce-back target is ours, and a path", () => {
		it("refuses a foreign Referer and uses the fallback", async () => {
			const { error } = await run(
				{
					method: "POST",
					headers: { host: "app.example", referer: "https://evil.example/phish" },
				},
				{ fallback: "/login" },
			);
			expect(error?.context.code).toBe(303);
			expect(error?.context.headers).toEqual({ Location: "/login" });
		});

		it("refuses a protocol-relative Referer", async () => {
			const { error } = await run(
				{ method: "POST", headers: { host: "app.example", referer: "//evil.example/phish" } },
				{ fallback: "/login" },
			);
			expect(error?.context.headers).toEqual({ Location: "/login" });
		});

		it("reduces our own absolute Referer to its path, so the bounce stays on this origin", async () => {
			const { error } = await run({
				method: "POST",
				headers: { host: "app.example", referer: "https://app.example/orders/create?x=1" },
			});
			expect(error?.context.headers).toEqual({ Location: "/orders/create?x=1" });
		});

		it("bounces a cross-origin SPA back onto the API's own origin", async () => {
			// Standalone mode: `Origin` legitimately names the SPA, so the Referer
			// is accepted — but an absolute Location would send the XHR to a server
			// that answers no CORS, and the bounce would die there.
			const { error } = await run({
				method: "POST",
				headers: {
					host: "api.example",
					origin: "https://spa.example",
					referer: "https://spa.example/orders/create",
				},
			});
			expect(error?.context.headers).toEqual({ Location: "/orders/create" });
		});
	});
});
