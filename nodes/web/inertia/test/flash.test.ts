/**
 * #996 — `redirectBack()` / `back()` / the chainable `flash()`, the
 * `withAllErrors` option (test 16), the page-object flash field (test 13) and
 * the 409 re-flash (test 15), all against the real node via `runNode`.
 *
 * The middleware round-trip through a live HTTP trigger (tests 7–12, 14) lives
 * in `triggers/http/__tests__/unit/HttpTrigger.inertia-middleware.test.ts` —
 * only the trigger can prove a middleware chain actually short-circuits.
 */

import { runNode } from "@blokjs/core/testing";
import { type RespondEnvelope, verifyFlash } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import InertiaNode, { back, flash, normalizeErrors, redirectBack } from "../src/index.js";
import type { PageObject } from "../src/protocol.js";

const SECRET = "inertia-flash-secret";
const INERTIA = { "x-inertia": "true" };
let previousSecret: string | undefined;

beforeAll(() => {
	previousSecret = process.env.BLOK_FLASH_SECRET;
	process.env.BLOK_FLASH_SECRET = SECRET;
});
afterAll(() => {
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
