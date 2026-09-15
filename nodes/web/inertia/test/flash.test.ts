/**
 * #996 — `redirectBack()` / `back()` / the chainable `flash()`, the
 * `withAllErrors` option (test 16), the page-object flash field (test 13) and
 * the 409 re-flash (test 15), all against the real node via `runNode`.
 *
 * The middleware round-trip through a live HTTP trigger (tests 7–12, 14, plus
 * the logout round-trip) lives in
 * `triggers/http/__tests__/unit/HttpTrigger.inertiaMiddleware.test.ts` — only
 * the trigger can prove a middleware chain actually short-circuits.
 */

import { http, defineNode, step, workflow } from "@blokjs/core";
import { runNode, runWorkflow } from "@blokjs/core/testing";
import { type RespondEnvelope, verifyFlash } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { definePage } from "../src/define-page.js";
import InertiaNode, { back, flash, logoutResponse, normalizeErrors, redirectBack } from "../src/index.js";
import type { PageObject } from "../src/protocol.js";

const SECRET = "inertia-flash-secret";
const INERTIA = { "x-inertia": "true" };
let previousSecret: string | undefined;

beforeAll(() => {
	previousSecret = process.env.BLOK_FLASH_SECRET;
	process.env.BLOK_FLASH_SECRET = SECRET;
});
afterAll(() => {
	// biome-ignore lint/performance/noDelete: the var must be ABSENT afterwards, not the string "undefined".
	if (previousSecret === undefined) delete process.env.BLOK_FLASH_SECRET;
	else process.env.BLOK_FLASH_SECRET = previousSecret;
});

async function run(input: Record<string, unknown>): Promise<RespondEnvelope> {
	return (await runNode(InertiaNode, input as never)) as unknown as RespondEnvelope;
}

function pageOf(env: RespondEnvelope): PageObject {
	return env.body as PageObject;
}

/** `blok_flash=<token>; Path=/; …` -> the verified payload. */
function payloadOf(setCookie: string | undefined) {
	if (!setCookie) return undefined;
	const token = setCookie.slice(setCookie.indexOf("=") + 1, setCookie.indexOf(";"));
	return verifyFlash(token, SECRET);
}

describe("redirectBack / back", () => {
	it("bounces to the Referer, persists errors + flash, and forces a 303 after a POST", () => {
		const env = redirectBack(
			{ headers: { referer: "/orders/new" }, method: "POST" },
			{ errors: { sku: "Required." }, flash: { toast: "nope" } },
		);
		expect(env.status).toBe(303);
		expect(env.headers?.Location).toBe("/orders/new");
		expect(payloadOf(env.cookies?.[0])).toEqual({
			errors: { sku: "Required." },
			flash: { toast: "nope" },
		});
	});

	it("falls back when there is no Referer, and stays a 302 on a GET", () => {
		const env = redirectBack({ headers: {}, method: "GET" }, { fallback: "/orders", errors: { sku: "Required." } });
		expect(env.status).toBe(302);
		expect(env.headers?.Location).toBe("/orders");
	});

	it("defaults the fallback to /", () => {
		expect(redirectBack({ headers: {} }).headers?.Location).toBe("/");
	});

	/**
	 * #1018 security review L1 — `Referer` is attacker-controllable, and this
	 * helper answers a FAILED WRITE: bouncing to another origin hands the flash
	 * cookie's errors to a page the attacker chose, which is exactly the shape
	 * of a credible phishing bounce after a failed sign-in.
	 */
	describe("only follows a SAME-ORIGIN Referer", () => {
		const host = { host: "app.example" };

		it.each([
			["https://evil.example/x", "a foreign absolute URL"],
			["//evil.example/x", "a protocol-relative URL, which is absolute to a browser"],
			["https://app.example.evil.example/x", "a host that merely starts with ours"],
			["not a url", "an unparsable value"],
		])("ignores %s (%s)", (referer) => {
			const env = redirectBack({ headers: { ...host, referer }, method: "POST" }, { fallback: "/login" });
			expect(env.headers?.Location).toBe("/login");
		});

		it("follows a relative Referer", () => {
			const env = redirectBack({ headers: { ...host, referer: "/login" }, method: "POST" }, { fallback: "/" });
			expect(env.headers?.Location).toBe("/login");
		});

		// #1003 — an accepted Referer bounces to its PATH, never to the absolute
		// URL. Same-origin behaviour is identical; standalone mode needs it,
		// because there the referring page is the SPA's origin and an absolute
		// Location sends the browser to a server that answers no CORS at all.
		it("follows an absolute Referer on our own Host, as a path", () => {
			const env = redirectBack(
				{ headers: { ...host, referer: "https://app.example/login?next=1" }, method: "POST" },
				{ fallback: "/" },
			);
			expect(env.headers?.Location).toBe("/login?next=1");
		});

		it("follows an absolute Referer matching the Origin header, as a path", () => {
			const env = redirectBack(
				{ headers: { origin: "https://app.example", referer: "https://app.example/login" }, method: "POST" },
				{ fallback: "/" },
			);
			expect(env.headers?.Location).toBe("/login");
		});

		it("bounces a CROSS-ORIGIN SPA back onto the API's own origin", () => {
			// Standalone mode: the Origin IS the SPA, so the Referer is legitimate
			// — but the redirect must stay relative, or the XHR follows it to the
			// Vite server and dies there.
			const env = redirectBack(
				{
					headers: {
						host: "api.example",
						origin: "https://spa.example",
						referer: "https://spa.example/orders/create",
					},
					method: "POST",
				},
				{ fallback: "/" },
			);
			expect(env.headers?.Location).toBe("/orders/create");
		});

		it("uses X-Forwarded-Host behind a proxy", () => {
			const env = redirectBack(
				{
					headers: {
						host: "internal:4000",
						"x-forwarded-host": "app.example",
						referer: "https://app.example/login",
					},
					method: "POST",
				},
				{ fallback: "/" },
			);
			expect(env.headers?.Location).toBe("/login");
		});
	});

	it("carries the error BAG and preserveFragment in the cookie", () => {
		const env = redirectBack(
			{ headers: { referer: "/orders#new" }, method: "PUT" },
			{ errors: { sku: "Required." }, bag: "createOrder", preserveFragment: true },
		);
		expect(payloadOf(env.cookies?.[0])).toEqual({
			errors: { sku: "Required." },
			bag: "createOrder",
			preserveFragment: true,
		});
	});

	it("sets no cookie when there is nothing to persist", () => {
		const env = redirectBack({ headers: { referer: "/orders" }, method: "POST" });
		expect(env.cookies).toBeUndefined();
		expect(env.status).toBe(303);
	});

	it("back() is redirectBack()", () => {
		expect(back).toBe(redirectBack);
	});

	// #1013's TODO(#996): the clearHistory mark is request-scoped, so the page
	// after a redirect only learns about it through the cookie.
	it("persists clearHistory, and logoutResponse uses it", () => {
		const explicit = redirectBack({ headers: { referer: "/app" }, method: "POST" }, { clearHistory: true });
		expect(payloadOf(explicit.cookies?.[0])).toEqual({ clearHistory: true });

		const out = logoutResponse({ request: { method: "POST" } }, { redirectTo: "/login" });
		expect(out.status).toBe(303);
		expect(out.headers?.Location).toBe("/login");
		expect(payloadOf(out.cookies?.[0])).toEqual({ clearHistory: true });
	});

	it("logoutResponse keeps working when no signing secret is configured", () => {
		const secret = process.env.BLOK_FLASH_SECRET;
		// biome-ignore lint/performance/noDelete: the var must be ABSENT, not the string "undefined".
		delete process.env.BLOK_FLASH_SECRET;
		try {
			const out = logoutResponse({ request: { method: "POST" } });
			expect(out.status).toBe(303);
			expect(out.cookies).toBeUndefined();
		} finally {
			process.env.BLOK_FLASH_SECRET = secret;
		}
	});
});

describe("flash() chain", () => {
	it("accumulates entries and merges them into a node input", () => {
		const input = flash("toast", { type: "ok" }).flash({ count: 2 }).render({ component: "Home" });
		expect(input).toEqual({ component: "Home", flash: { toast: { type: "ok" }, count: 2 } });
	});

	// Test 13
	it("puts the chained flash on the page object, and nothing on the next request", async () => {
		const rendered = await run(flash("toast", { type: "ok" }).render({ component: "Home", headers: INERTIA }));
		expect(pageOf(rendered).flash).toEqual({ toast: { type: "ok" } });

		const next = await run({ component: "Home", headers: INERTIA });
		expect(pageOf(next).flash).toBeUndefined();
	});

	it("chains into redirectBack, carrying flash AND errors", () => {
		const env = flash("toast", "saved").redirectBack(
			{ headers: { referer: "/orders" }, method: "POST" },
			{ errors: { sku: "Required." } },
		);
		expect(payloadOf(env.cookies?.[0])).toEqual({ errors: { sku: "Required." }, flash: { toast: "saved" } });
	});
});

describe("withAllErrors (test 16)", () => {
	it("normalizeErrors picks one message by default and every message when asked", () => {
		const raw = { sku: ["Required.", "Too short."], name: "Required." };
		expect(normalizeErrors(raw)).toEqual({ sku: "Required.", name: "Required." });
		expect(normalizeErrors(raw, { withAllErrors: true })).toEqual({
			sku: ["Required.", "Too short."],
			name: ["Required."],
		});
	});

	it("the node ships strings by default and arrays with withAllErrors", async () => {
		const input = { component: "Orders/New", headers: INERTIA, errors: { sku: ["Required.", "Too short."] } };
		expect(pageOf(await run(input)).props.errors).toEqual({ sku: "Required." });
		expect(pageOf(await run({ ...input, withAllErrors: true })).props.errors).toEqual({
			sku: ["Required.", "Too short."],
		});
	});
});

describe("cookies pass-through", () => {
	it("emits the clearing flash cookie the middleware handed it", async () => {
		const clearing = "blok_flash=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
		const json = await run({ component: "Home", headers: INERTIA, cookies: [clearing] });
		expect(json.cookies).toEqual([clearing]);
		const html = await run({ component: "Home", cookies: [clearing] });
		expect(html.cookies).toEqual([clearing]);
	});
});

describe("409 re-flash (test 15)", () => {
	const conflict = {
		component: "Orders/Index",
		url: "/orders",
		version: "v2",
		headers: { ...INERTIA, "x-inertia-version": "v1" },
	};

	it("re-signs pending flash + errors so they survive the forced full visit", async () => {
		const env = await run({ ...conflict, flash: { toast: "saved" }, errors: { sku: "Required." } });
		expect(env.status).toBe(409);
		expect(env.headers?.["X-Inertia-Location"]).toBe("/orders");
		expect(payloadOf(env.cookies?.[0])).toEqual({ errors: { sku: "Required." }, flash: { toast: "saved" } });
	});

	it("nests the error bag the request asked for", async () => {
		const env = await run({
			...conflict,
			headers: { ...conflict.headers, "x-inertia-error-bag": "createOrder" },
			errors: { sku: "Required." },
		});
		expect(payloadOf(env.cookies?.[0])?.bag).toBe("createOrder");
	});

	it("sets no cookie when there was no pending flash", async () => {
		const env = await run(conflict);
		expect(env.status).toBe(409);
		expect(env.cookies).toBeUndefined();
	});
});

// =============================================================================
// The `page` control step folds the flash bag in (the #996 seam in PageNode)
// =============================================================================

/**
 * Stands in for `@blokjs/flash`'s `read` op: same state slot, same output
 * shape. A local node keeps this package's tests free of a static import of
 * `@blokjs/helpers`, which imports THIS package dynamically. The real node
 * behind the real middleware is exercised in
 * `triggers/http/__tests__/unit/HttpTrigger.inertiaMiddleware.test.ts`.
 */
const CLEARING = "blok_flash=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
const flashSlot = defineNode({
	name: "test/flash-slot",
	description: "Fill ctx.state.flash the way @blokjs/flash's read op does.",
	input: z.object({
		errors: z.record(z.unknown()).optional(),
		bag: z.string().optional(),
		flash: z.record(z.unknown()).optional(),
		preserveFragment: z.boolean().optional(),
		clearHistory: z.boolean().optional(),
	}),
	output: z.object({
		present: z.boolean(),
		errors: z.record(z.unknown()),
		bag: z.string().optional(),
		flash: z.record(z.unknown()),
		preserveFragment: z.boolean(),
		clearHistory: z.boolean().optional(),
		cookie: z.string(),
	}),
	async execute(_ctx, input) {
		return {
			present: true,
			errors: input.errors ?? {},
			bag: input.bag,
			flash: input.flash ?? {},
			preserveFragment: input.preserveFragment === true,
			clearHistory: input.clearHistory === true ? true : undefined,
			cookie: CLEARING,
		};
	},
});

const hint = defineNode({
	name: "test/flash-hint",
	description: "one ordinary page prop",
	input: z.object({}),
	output: z.object({ text: z.string() }),
	async execute() {
		return { text: "fill in the sku" };
	},
});

/** A prior step whose output an author would hand to `render()`'s `errors`. */
const validator = defineNode({
	name: "test/flash-validator",
	description: "a step whose errors a page passes to render()",
	input: z.object({}),
	output: z.object({ errors: z.record(z.unknown()) }),
	async execute() {
		return { errors: { sku: "bad" } };
	},
});

const FlashPage = definePage("Orders/New", { hint });

/** `middleware` = what the flash step reports; `opts` = explicit render options. */
function flashPageWorkflow(middleware: Record<string, unknown> | null, opts: Record<string, unknown> = {}) {
	return workflow("flash-page", { version: "1.0.0", trigger: http.get("/orders/new") }, (req) => {
		if (middleware) step("flash", flashSlot, middleware);
		FlashPage.render(req, "page", "/orders/new", {}, { version: "v1", ...opts });
	});
}

describe("page step folds the flash bag into the serializer", () => {
	// Test (d)
	it("hands the merged flash fields to the serializer step's inputs", async () => {
		const run = await runWorkflow(
			await flashPageWorkflow({ errors: { sku: "Required." }, bag: "createOrder", flash: { toast: "saved" } }),
			{},
			{ headers: INERTIA },
		);
		expect(run.ok).toBe(true);

		const inputs = run.step("page.$render")?.inputs as Record<string, unknown>;
		expect(inputs.errors).toEqual({ sku: "Required." });
		expect(inputs.errorBag).toBe("createOrder");
		expect(inputs.flash).toEqual({ toast: "saved" });
		expect(inputs.cookies).toEqual([CLEARING]);

		const page = pageOf(run.response as RespondEnvelope);
		expect(page.props.errors).toEqual({ createOrder: { sku: "Required." } });
		expect(page.flash).toEqual({ toast: "saved" });
		expect((run.response as RespondEnvelope).cookies).toEqual([CLEARING]);
	});

	it("carries preserveFragment and clearHistory, and only when they are true", async () => {
		const on = await runWorkflow(
			await flashPageWorkflow({ flash: { a: 1 }, preserveFragment: true, clearHistory: true }),
			{},
			{ headers: INERTIA },
		);
		const onPage = pageOf(on.response as RespondEnvelope);
		expect(onPage.preserveFragment).toBe(true);
		expect(onPage.clearHistory).toBe(true);

		const off = await runWorkflow(await flashPageWorkflow({ flash: { a: 1 } }), {}, { headers: INERTIA });
		const offPage = pageOf(off.response as RespondEnvelope);
		expect(offPage.preserveFragment).toBeUndefined();
		expect(offPage.clearHistory).toBeUndefined();
	});

	// Test (b)
	it("lets explicit render() options win, merging errors and flash on top", async () => {
		const run = await runWorkflow(
			await flashPageWorkflow(
				{ errors: { sku: "Required.", name: "From the middleware." }, bag: "createOrder", flash: { toast: "old" } },
				{ errors: { name: "From render()." }, flash: { toast: "new" }, errorBag: "explicitBag" },
			),
			{},
			{ headers: INERTIA },
		);

		const inputs = run.step("page.$render")?.inputs as Record<string, unknown>;
		// The author's key replaces; the middleware's other key survives.
		expect(inputs.errors).toEqual({ sku: "Required.", name: "From render()." });
		expect(inputs.flash).toEqual({ toast: "new" });
		expect(inputs.errorBag).toBe("explicitBag");
	});

	it("appends the clearing cookie to explicit cookies rather than replacing them", async () => {
		const mine = "sid=abc; Path=/";
		const run = await runWorkflow(
			await flashPageWorkflow({ flash: { a: 1 } }, { cookies: [mine] }),
			{},
			{ headers: INERTIA },
		);
		expect((run.response as RespondEnvelope).cookies).toEqual([mine, CLEARING]);
	});

	// Test (c)
	it("renders with errors: {} and no cookie when no flash middleware ran", async () => {
		const run = await runWorkflow(await flashPageWorkflow(null), {}, { headers: INERTIA });
		expect(run.ok).toBe(true);

		const page = pageOf(run.response as RespondEnvelope);
		expect(page.props.errors).toEqual({});
		expect(page.props.hint).toEqual({ text: "fill in the sku" });
		expect(page.flash).toBeUndefined();
		expect((run.response as RespondEnvelope).cookies).toBeUndefined();
	});

	// The author's `render()` options reach `PageNode` in their LOWERED form —
	// a handle is a `{$ref}` object (or the `js/…` string it lowers to), not a
	// value. Merging into one would corrupt the object AND break the reference.
	it("leaves an explicit errors HANDLE untouched instead of merging into it", async () => {
		const run = await runWorkflow(
			await workflow("flash-page-handle", { version: "1.0.0", trigger: http.get("/orders/new") }, (req) => {
				step("flash", flashSlot, { errors: { email: "taken" } });
				const validation = step("validation", validator, {});
				FlashPage.render(req, "page", "/orders/new", {}, { version: "v1", errors: validation.errors });
			}),
			{},
			{ headers: INERTIA },
		);
		expect(run.ok).toBe(true);

		// The handle won WHOLE: the middleware's `email` is not merged in, and
		// no `$ref` key leaked into the errors object.
		const errors = pageOf(run.response as RespondEnvelope).props.errors as Record<string, unknown>;
		expect(errors).toEqual({ sku: "bad" });
		expect(JSON.stringify(errors)).not.toContain("$ref");
	});

	it("still merges when the explicit value is a plain literal", async () => {
		const run = await runWorkflow(
			await flashPageWorkflow({ errors: { email: "taken" } }, { errors: { sku: "bad" } }),
			{},
			{ headers: INERTIA },
		);
		expect(pageOf(run.response as RespondEnvelope).props.errors).toEqual({ email: "taken", sku: "bad" });
	});

	it("leaves an explicit `js/` expression untouched", async () => {
		const run = await runWorkflow(
			await flashPageWorkflow({ errors: { email: "taken" } }, { errors: "js/({ sku: 'bad' })" }),
			{},
			{ headers: INERTIA },
		);
		expect(pageOf(run.response as RespondEnvelope).props.errors).toEqual({ sku: "bad" });
	});

	it("ignores a `flash` state slot that is not the flash node's output", async () => {
		const run = await runWorkflow(
			await workflow("flash-page-shadowed", { version: "1.0.0", trigger: http.get("/orders/new") }, (req) => {
				// A page whose own step happens to be called `flash`.
				step("flash", hint, {});
				FlashPage.render(req, "page", "/orders/new", {}, { version: "v1" });
			}),
			{},
			{ headers: INERTIA },
		);
		expect(run.ok).toBe(true);
		expect(pageOf(run.response as RespondEnvelope).props.errors).toEqual({});
		expect((run.response as RespondEnvelope).cookies).toBeUndefined();
	});
});
