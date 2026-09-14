/**
 * `@blokjs/session` unit tests (#1018) — the "session sign / verify / rotation"
 * row of the issue's unit-test list, plus the cookie flags and the two local
 * store backends.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MemorySessionStore,
	SESSION_COOKIE,
	SESSION_SECRET_ENV,
	SqliteSessionStore,
	_resetSession,
	clearSessionCookie,
	configureSession,
	destroySession,
	getSessionStore,
	loadSession,
	readSessionCookie,
	regenerateSession,
	resolveSessionSecret,
	saveSession,
	sessionSetCookie,
	signSessionId,
	startSession,
	verifySessionId,
} from "../src/index.js";

const SECRET = "unit-test-session-secret-value";

/** A ctx stand-in: everything here only ever reads `ctx.request`. */
function makeCtx(cookie?: string): { request: { headers: Record<string, string> } } {
	return { request: { headers: cookie ? { cookie } : {} } };
}

/** `blok_session=<token>; Path=/; …` → the `Cookie:` header pair. */
function pair(setCookie: string): string {
	return setCookie.split(";")[0] as string;
}

describe("@blokjs/session — secret", () => {
	it("throws naming the variable, with a Fix: line, when it is unset", () => {
		expect(() => resolveSessionSecret()).toThrowError(
			new RegExp(`${SESSION_SECRET_ENV}[\\s\\S]*Fix:[\\s\\S]*${SESSION_SECRET_ENV}`),
		);
	});

	it("refuses a secret too short to be an HMAC key", () => {
		expect(() => resolveSessionSecret("short")).toThrowError(/Fix:/);
	});

	it("accepts an explicit secret and the env var", () => {
		expect(resolveSessionSecret(SECRET)).toBe(SECRET);
		process.env[SESSION_SECRET_ENV] = SECRET;
		expect(resolveSessionSecret()).toBe(SECRET);
		// `delete`, not `= undefined`: the var must be ABSENT again, not the
		// literal string "undefined".
		delete process.env[SESSION_SECRET_ENV];
	});
});

describe("@blokjs/session — cookie signing", () => {
	it("round-trips a session id", () => {
		const token = signSessionId("abc123", SECRET);
		expect(verifySessionId(token, SECRET)).toBe("abc123");
	});

	it("rejects a tampered id, a tampered MAC, a wrong secret and junk", () => {
		const token = signSessionId("abc123", SECRET);
		const [id, mac] = token.split(".") as [string, string];
		expect(verifySessionId(`${id}X.${mac}`, SECRET)).toBeUndefined();
		expect(verifySessionId(`${id}.${mac.slice(0, -1)}Z`, SECRET)).toBeUndefined();
		expect(verifySessionId(token, `${SECRET}-other`)).toBeUndefined();
		expect(verifySessionId("not-a-token", SECRET)).toBeUndefined();
		expect(verifySessionId(undefined, SECRET)).toBeUndefined();
	});

	it("sets HttpOnly, SameSite=Lax and Path=/ — and never Secure by default", () => {
		const cookie = sessionSetCookie(signSessionId("abc", SECRET));
		expect(cookie).toContain(`${SESSION_COOKIE}=abc.`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("Max-Age=");
		expect(cookie).not.toContain("Secure");
	});

	it("forces Secure on SameSite=None (browsers reject it otherwise) and clears with Max-Age=0", () => {
		expect(sessionSetCookie("t", { sameSite: "None" })).toContain("Secure");
		const cleared = clearSessionCookie();
		expect(cleared).toContain(`${SESSION_COOKIE}=;`);
		expect(cleared).toContain("Max-Age=0");
		expect(cleared).toContain("HttpOnly");
	});

	it("reads the signed id back out of a Cookie header", () => {
		const cookie = pair(sessionSetCookie(signSessionId("abc", SECRET)));
		expect(readSessionCookie({ cookie: `other=1; ${cookie}` }, SECRET)).toBe("abc");
		expect(readSessionCookie({ cookie: `${SESSION_COOKIE}=forged.mac` }, SECRET)).toBeUndefined();
		expect(readSessionCookie(undefined, SECRET)).toBeUndefined();
	});
});

describe("@blokjs/session — lifecycle", () => {
	beforeEach(() => {
		_resetSession();
		configureSession({ store: new MemorySessionStore(), secret: SECRET });
	});

	it("starts a session, issues its cookie, and reads it back on the next request", async () => {
		const first = makeCtx();
		const { state, cookie } = await startSession(first, { userId: "u-1" });
		expect(state.id).toBeTruthy();
		expect(state.data).toEqual({ userId: "u-1" });

		const next = makeCtx(pair(cookie));
		const loaded = await loadSession(next);
		expect(loaded.id).toBe(state.id);
		expect(loaded.data).toEqual({ userId: "u-1" });
	});

	it("a request with no cookie — or an unknown one — is signed out, not an error", async () => {
		expect(await loadSession(makeCtx())).toEqual({ id: null, data: {} });
		const orphan = pair(sessionSetCookie(signSessionId("never-stored", SECRET)));
		expect(await loadSession(makeCtx(orphan))).toEqual({ id: null, data: {} });
	});

	it("rotation: a new id carrying the same data, and the OLD record is destroyed", async () => {
		const login = makeCtx();
		const { cookie } = await startSession(login, { userId: "u-1" });
		const oldId = (await loadSession(login)).id as string;

		const next = makeCtx(pair(cookie));
		const rotated = await regenerateSession(next);
		expect(rotated.state.id).not.toBe(oldId);
		expect(rotated.state.data).toEqual({ userId: "u-1" });
		// The fixation guard: the pre-rotation cookie now names nothing.
		expect(await getSessionStore().read(oldId)).toBeUndefined();
		expect(await loadSession(makeCtx(pair(cookie)))).toEqual({ id: null, data: {} });
	});

	it("saveSession merges into the live session, and creates one when there is none", async () => {
		const guest = makeCtx();
		const created = await saveSession(guest, { intended: "/orders" });
		expect(created.cookie).toBeTruthy();
		expect(created.state.data).toEqual({ intended: "/orders" });

		const next = makeCtx(pair(created.cookie as string));
		const merged = await saveSession(next, { userId: "u-9" });
		expect(merged.cookie).toBeUndefined();
		expect(merged.state.data).toEqual({ intended: "/orders", userId: "u-9" });
	});

	it("destroySession removes the record and returns the clearing cookie", async () => {
		const login = makeCtx();
		const { cookie } = await startSession(login, { userId: "u-1" });
		const next = makeCtx(pair(cookie));
		const clearing = await destroySession(next);
		expect(clearing).toContain("Max-Age=0");
		expect(await loadSession(makeCtx(pair(cookie)))).toEqual({ id: null, data: {} });
	});
});

describe("@blokjs/session — stores", () => {
	it("memory: reads back, and an expired record is gone", async () => {
		const store = new MemorySessionStore();
		await store.write({ id: "a", data: { x: 1 }, expiresAt: Date.now() + 10_000 });
		expect((await store.read("a"))?.data).toEqual({ x: 1 });
		await store.write({ id: "b", data: {}, expiresAt: Date.now() - 1 });
		expect(await store.read("b")).toBeUndefined();
	});

	it("sqlite: reads back across instances, expires, and destroys", async () => {
		const dir = mkdtempSync(join(tmpdir(), "blok-session-"));
		const file = join(dir, "sessions.db");
		try {
			const store = new SqliteSessionStore(file);
			await store.write({ id: "a", data: { userId: "u-1" }, expiresAt: Date.now() + 10_000 });
			await store.write({ id: "b", data: {}, expiresAt: Date.now() - 1 });
			store.close();

			// A second process opening the same file sees the same session — the
			// whole point of the default backend.
			const reopened = new SqliteSessionStore(file);
			expect((await reopened.read("a"))?.data).toEqual({ userId: "u-1" });
			expect(await reopened.read("b")).toBeUndefined();
			await reopened.destroy("a");
			expect(await reopened.read("a")).toBeUndefined();
			reopened.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	afterEach(() => {
		_resetSession();
	});
});
