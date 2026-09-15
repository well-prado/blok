/**
 * `@blokjs/auth` reset-token + throttle + UserStore unit tests (#1018) — the
 * issue's "reset token single-use + expiry" row, plus the two pieces the login
 * flow leans on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_SECRET_ENV } from "@blokjs/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DuplicateEmailError,
	MemoryUserStore,
	SqliteUserStore,
	_resetAuth,
	_resetThrottle,
	clearThrottle,
	configureAuth,
	consumeResetToken,
	createResetToken,
	getUserStore,
	hashResetToken,
	hitThrottle,
	throttleKey,
} from "../src/index.js";

const SECRET = "unit-test-session-secret-value";

let users: MemoryUserStore;

beforeEach(() => {
	process.env[SESSION_SECRET_ENV] = SECRET;
	_resetAuth();
	_resetThrottle();
	users = new MemoryUserStore();
	configureAuth({ users, secret: SECRET });
});

afterEach(() => {
	_resetAuth();
	// `delete`, not `= undefined`: the var must be ABSENT between suites, not
	// the literal string "undefined".
	delete process.env[SESSION_SECRET_ENV];
});

describe("@blokjs/auth — reset tokens", () => {
	it("stores the token HASHED, never the raw value", async () => {
		await users.create({ name: "Ada", email: "ada@example.com", passwordHash: "scrypt$1$1$1$a$b" });
		const issued = await createResetToken("ada@example.com");
		expect(issued?.token).toBeTruthy();
		const stored = hashResetToken(issued?.token as string);
		expect(stored).not.toBe(issued?.token);
		// The store only ever sees the HMAC, so the raw token is unusable from a dump.
		expect(await users.consumeResetToken(stored)).toEqual({ userId: issued?.userId });
	});

	it("is single-use: the second presentation of the same token is refused", async () => {
		const user = await users.create({ name: "Ada", email: "ada@example.com", passwordHash: "h" });
		const issued = await createResetToken("ada@example.com");
		expect(await consumeResetToken(issued?.token as string)).toBe(user.id);
		expect(await consumeResetToken(issued?.token as string)).toBeUndefined();
	});

	it("expires: a token past its TTL is refused, and is still spent", async () => {
		await users.create({ name: "Ada", email: "ada@example.com", passwordHash: "h" });
		// A TTL of zero puts `expiresAt` in the past the instant it is written.
		configureAuth({ resetTokenTtl: 0 });
		const issued = await createResetToken("ada@example.com");
		expect(await consumeResetToken(issued?.token as string)).toBeUndefined();
	});

	it("issues nothing for an unknown address (the caller still answers neutrally)", async () => {
		expect(await createResetToken("nobody@example.com")).toBeUndefined();
		expect(await consumeResetToken("")).toBeUndefined();
		expect(await consumeResetToken("garbage")).toBeUndefined();
	});

	it("a token is only valid under the secret that signed it", async () => {
		await users.create({ name: "Ada", email: "ada@example.com", passwordHash: "h" });
		const issued = await createResetToken("ada@example.com");
		// Same raw token, different key → a different stored hash, so no match.
		expect(hashResetToken(issued?.token as string, `${SECRET}-other`)).not.toBe(
			hashResetToken(issued?.token as string),
		);
	});
});

describe("@blokjs/auth — throttle", () => {
	it("allows the limit and refuses the one after it, with a retry window", async () => {
		const key = throttleKey({ "x-forwarded-for": "203.0.113.7" }, "Ada@Example.com", { trustProxy: true });
		expect(key).toBe("203.0.113.7|ada@example.com");
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			expect((await hitThrottle(key, { limit: 5 })).allowed).toBe(true);
		}
		const blocked = await hitThrottle(key, { limit: 5 });
		expect(blocked.allowed).toBe(false);
		expect(blocked.count).toBe(6);
		expect(blocked.retryAfter).toBeGreaterThan(0);
	});

	it("buckets per IP AND email, so one attacker cannot lock out a victim", async () => {
		const attacker = throttleKey({ "x-forwarded-for": "203.0.113.7" }, "ada@example.com", { trustProxy: true });
		const victim = throttleKey({ "x-forwarded-for": "198.51.100.9" }, "ada@example.com", { trustProxy: true });
		for (let attempt = 0; attempt < 6; attempt += 1) await hitThrottle(attacker, { limit: 5 });
		expect((await hitThrottle(victim, { limit: 5 })).allowed).toBe(true);
	});

	it("a successful login clears the bucket", async () => {
		const key = throttleKey({}, "ada@example.com");
		// No trusted proxy and no forwarding header: one bucket per address.
		expect(key.startsWith("direct|")).toBe(true);
		for (let attempt = 0; attempt < 5; attempt += 1) await hitThrottle(key, { limit: 5 });
		await clearThrottle(key);
		expect((await hitThrottle(key, { limit: 5 })).allowed).toBe(true);
	});

	it("the window is fixed: attempts stop counting once it closes", async () => {
		const key = throttleKey({}, "expiring@example.com");
		for (let attempt = 0; attempt < 6; attempt += 1) await hitThrottle(key, { limit: 5, windowSeconds: 0.001 });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect((await hitThrottle(key, { limit: 5, windowSeconds: 0.001 })).allowed).toBe(true);
	});
});

describe("@blokjs/auth — UserStore", () => {
	it("matches email case-insensitively and refuses a duplicate", async () => {
		await users.create({ name: "Ada", email: "Ada@Example.COM", passwordHash: "h" });
		expect((await users.findByEmail("ada@example.com"))?.name).toBe("Ada");
		await expect(users.create({ name: "Other", email: "ADA@example.com", passwordHash: "h" })).rejects.toBeInstanceOf(
			DuplicateEmailError,
		);
	});

	it("the sqlite default persists users and reset tokens across instances", async () => {
		const dir = mkdtempSync(join(tmpdir(), "blok-auth-"));
		const file = join(dir, "auth.db");
		try {
			const store = new SqliteUserStore(file);
			const user = await store.create({ name: "Ada", email: "Ada@Example.com", passwordHash: "h1" });
			await store.updatePassword(user.id, "h2");
			await store.createResetToken({ userId: user.id, tokenHash: "hash-1", expiresAt: Date.now() + 10_000 });
			store.close();

			const reopened = new SqliteUserStore(file);
			expect((await reopened.findByEmail("ada@example.com"))?.passwordHash).toBe("h2");
			expect((await reopened.findById(user.id))?.email).toBe("ada@example.com");
			await expect(reopened.create({ name: "x", email: "ADA@example.com", passwordHash: "h" })).rejects.toBeInstanceOf(
				DuplicateEmailError,
			);
			// Single-use survives a restart too.
			expect(await reopened.consumeResetToken("hash-1")).toEqual({ userId: user.id });
			expect(await reopened.consumeResetToken("hash-1")).toBeUndefined();
			reopened.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults to an in-memory store under NODE_ENV=test", () => {
		_resetAuth();
		expect(getUserStore()).toBeInstanceOf(MemoryUserStore);
	});
});

/**
 * #1018 security review H2 — `X-Forwarded-For` is an ordinary request header.
 * Reading it unconditionally made the throttle a formality: rotate it per
 * attempt and every guess lands in a fresh bucket.
 */
describe("@blokjs/auth — the throttle only trusts a proxy when told to", () => {
	const EMAIL = "ada@example.com";

	it("ignores forwarding headers by default, so a rotated header cannot mint buckets", async () => {
		const keys = new Set<string>();
		for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
			keys.add(throttleKey({ "x-forwarded-for": ip }, EMAIL));
		}
		// One bucket, not three.
		expect(keys.size).toBe(1);

		// ...and that bucket really does run out.
		const key = [...keys][0] as string;
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			expect((await hitThrottle(key, { limit: 5 })).allowed).toBe(true);
		}
		expect((await hitThrottle(throttleKey({ "x-forwarded-for": "203.0.113.9" }, EMAIL), { limit: 5 })).allowed).toBe(
			false,
		);
	});

	it("ignores X-Real-IP and CF-Connecting-IP too", () => {
		const plain = throttleKey(undefined, EMAIL);
		expect(throttleKey({ "x-real-ip": "203.0.113.1" }, EMAIL)).toBe(plain);
		expect(throttleKey({ "cf-connecting-ip": "203.0.113.1" }, EMAIL)).toBe(plain);
	});

	it("reads X-Forwarded-For when configureAuth({ trustProxy: true })", () => {
		configureAuth({ trustProxy: true });
		expect(throttleKey({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, EMAIL)).toBe("203.0.113.7|ada@example.com");
	});

	it("reads X-Forwarded-For when BLOK_TRUST_PROXY=1", () => {
		process.env.BLOK_TRUST_PROXY = "1";
		try {
			expect(throttleKey({ "x-forwarded-for": "203.0.113.7" }, EMAIL)).toBe("203.0.113.7|ada@example.com");
		} finally {
			delete process.env.BLOK_TRUST_PROXY;
		}
	});

	it("an explicit option beats the env var in both directions", () => {
		process.env.BLOK_TRUST_PROXY = "1";
		try {
			expect(throttleKey({ "x-forwarded-for": "203.0.113.7" }, EMAIL, { trustProxy: false })).toBe(
				"direct|ada@example.com",
			);
		} finally {
			delete process.env.BLOK_TRUST_PROXY;
		}
	});
});
