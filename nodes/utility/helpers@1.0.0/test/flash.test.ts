/**
 * #996 tests 1–6 — the signed one-shot flash cookie and the `headers`/`cookies`
 * fields `@blokjs/throw` gained so a middleware can answer with a redirect.
 *
 * Tests 1–5 drive the real node through `runNode` (Zod in, Zod out, the node's
 * own `handle()` path). Test 6 goes through `handle()` directly, because the
 * point of the assertion is the GlobalError INSTANCE — `runNode` deliberately
 * re-wraps a failure as a plain Error.
 */

import { runNode } from "@blokjs/runner/testing";
import type { Context, GlobalError } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FlashNode from "../src/flash";
import ThrowNode from "../src/throw";

const SECRET = "test-flash-secret";
const PAYLOAD = { errors: { sku: "Required." }, bag: "createOrder", flash: { toast: { type: "ok" } } };

function ctxFor(): Context {
	return {
		id: "test-req",
		workflow_name: "test-wf",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { data: {}, success: true, error: null },
		error: { message: [] },
		logger: { log: vi.fn(), error: vi.fn(), logLevel: vi.fn() },
		config: {},
		state: {},
		vars: {},
		env: {},
	} as unknown as Context;
}

/** `blok_flash=<token>; …` -> `<token>` */
function tokenOf(setCookie: string): string {
	return setCookie.slice(setCookie.indexOf("=") + 1, setCookie.indexOf(";"));
}

describe("@blokjs/flash (#996)", () => {
	beforeEach(() => {
		process.env.BLOK_FLASH_SECRET = SECRET;
	});
	afterEach(() => {
		process.env.BLOK_FLASH_SECRET = SECRET;
	});

	// Test 1
	it("round-trips a payload written and read with the same secret", async () => {
		const written = await runNode(FlashNode, { op: "write", ...PAYLOAD });
		expect(written.cookie).toContain("HttpOnly");
		expect(written.cookie).toContain("SameSite=Lax");
		expect(written.cookie).toContain("Path=/");

		const read = await runNode(FlashNode, { op: "read", cookieHeader: written.cookie.split(";")[0] });
		expect(read.present).toBe(true);
		expect(read.errors).toEqual(PAYLOAD.errors);
		expect(read.bag).toBe("createOrder");
		expect(read.flash).toEqual(PAYLOAD.flash);
	});

	// Test 2
	it("returns nothing when one byte of the cookie is flipped", async () => {
		const written = await runNode(FlashNode, { op: "write", ...PAYLOAD });
		const token = tokenOf(written.cookie);
		// Flip a character in the SIGNED BODY (not the signature) — the payload
		// still base64-decodes, so only the MAC can catch this.
		const [body, mac] = token.split(".");
		const flipped = `${body.slice(0, -1)}${body.slice(-1) === "A" ? "B" : "A"}.${mac}`;

		const read = await runNode(FlashNode, { op: "read", cookieHeader: `blok_flash=${flipped}` });
		expect(read.present).toBe(false);
		expect(read.errors).toEqual({});
		expect(read.value).toBeUndefined();
	});

	// Test 2b — the signature half, same contract.
	it("returns nothing when the signature is tampered with", async () => {
		const written = await runNode(FlashNode, { op: "write", ...PAYLOAD });
		const [body, mac] = tokenOf(written.cookie).split(".");
		const forged = `${body}.${mac.slice(0, -1)}${mac.slice(-1) === "A" ? "B" : "A"}`;
		const read = await runNode(FlashNode, { op: "read", cookieHeader: `blok_flash=${forged}` });
		expect(read.present).toBe(false);
	});

	// Test 3
	it("returns nothing when the cookie was signed with a different secret", async () => {
		const written = await runNode(FlashNode, { op: "write", ...PAYLOAD, secret: "someone-elses-secret" });
		const read = await runNode(FlashNode, { op: "read", cookieHeader: written.cookie.split(";")[0] });
		expect(read.present).toBe(false);
		expect(read.flash).toEqual({});
	});

	// Test 4
	it("read emits a clearing Set-Cookie with Max-Age=0 for the key", async () => {
		const written = await runNode(FlashNode, { op: "write", ...PAYLOAD });
		const read = await runNode(FlashNode, { op: "read", cookieHeader: written.cookie.split(";")[0] });
		expect(read.cookie).toMatch(/^blok_flash=;/);
		expect(read.cookie).toContain("Max-Age=0");
		expect(read.cookie).toContain("HttpOnly");
	});

	it("honours a custom cookie name on both sides", async () => {
		const written = await runNode(FlashNode, { op: "write", flash: { a: 1 }, name: "my_flash" });
		expect(written.cookie.startsWith("my_flash=")).toBe(true);
		const read = await runNode(FlashNode, {
			op: "read",
			name: "my_flash",
			cookieHeader: `other=1; ${written.cookie.split(";")[0]}; another=2`,
		});
		expect(read.flash).toEqual({ a: 1 });
		expect(read.cookie).toContain("my_flash=;");
	});

	it("reads an absent cookie as empty rather than failing", async () => {
		const read = await runNode(FlashNode, { op: "read", cookieHeader: "session=abc" });
		expect(read.present).toBe(false);
		expect(read.errors).toEqual({});
		expect(read.flash).toEqual({});
		expect(read.preserveFragment).toBe(false);
	});

	// Test 5
	it("fails, naming BLOK_FLASH_SECRET, when no secret is configured", async () => {
		process.env.BLOK_FLASH_SECRET = undefined;
		// biome-ignore lint/performance/noDelete: the env var must be ABSENT, not "undefined".
		delete process.env.BLOK_FLASH_SECRET;
		await expect(runNode(FlashNode, { op: "write", flash: { a: 1 } })).rejects.toThrow(/BLOK_FLASH_SECRET/);
		await expect(runNode(FlashNode, { op: "read", cookieHeader: "" })).rejects.toThrow(/BLOK_FLASH_SECRET/);
	});
});

describe("@blokjs/throw — headers + cookies (#996)", () => {
	// Test 6
	it("carries `headers` and `cookies` onto the thrown GlobalError", async () => {
		const res = await ThrowNode.handle(ctxFor(), {
			message: "Unauthenticated.",
			code: 302,
			headers: { Location: "/login" },
			cookies: ["blok_flash=abc; Path=/"],
		});
		const error = (res as { error: GlobalError }).error;
		expect(error.context.code).toBe(302);
		expect(error.context.headers).toEqual({ Location: "/login" });
		expect(error.context.cookies).toEqual(["blok_flash=abc; Path=/"]);
		expect(error.context.message).toContain("Unauthenticated.");
	});

	it("leaves headers/cookies unset when not supplied", async () => {
		const res = await ThrowNode.handle(ctxFor(), { message: "boom", code: 401 });
		const error = (res as { error: GlobalError }).error;
		expect(error.context.headers).toBeUndefined();
		expect(error.context.cookies).toBeUndefined();
	});
});
