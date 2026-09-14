/**
 * `@blokjs/auth` password unit tests (#1018) — the issue's "password hash /
 * verify round-trip and rejection" row.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SCRYPT, decoyHash, hashPassword, verifyPassword } from "../src/index.js";

// scrypt at 2^15 is deliberately slow; a handful of hashes fits comfortably.
const TIMEOUT = 30_000;

describe("@blokjs/auth — hashPassword / verifyPassword", () => {
	it(
		"round-trips the right password and rejects the wrong one",
		async () => {
			const stored = await hashPassword("correct horse battery staple");
			expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
			expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
			expect(await verifyPassword("", stored)).toBe(false);
			expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false);
		},
		TIMEOUT,
	);

	it(
		"salts every hash, so the same password never produces the same digest",
		async () => {
			const [a, b] = await Promise.all([hashPassword("hunter2hunter2"), hashPassword("hunter2hunter2")]);
			expect(a).not.toBe(b);
			expect(await verifyPassword("hunter2hunter2", a)).toBe(true);
			expect(await verifyPassword("hunter2hunter2", b)).toBe(true);
		},
		TIMEOUT,
	);

	it(
		"writes self-describing parameters, so an old hash still verifies after the cost is raised",
		async () => {
			const cheap = await hashPassword("a-long-enough-password", { N: 1024 });
			expect(cheap.startsWith("scrypt$1024$8$1$")).toBe(true);
			expect(cheap.split("$")).toHaveLength(6);
			// Verification uses the parameters IN THE HASH, not today's defaults.
			expect(DEFAULT_SCRYPT.N).not.toBe(1024);
			expect(await verifyPassword("a-long-enough-password", cheap)).toBe(true);
		},
		TIMEOUT,
	);

	it("refuses to hash an empty password", async () => {
		await expect(hashPassword("")).rejects.toThrow(/non-empty/);
	});

	it("reports a foreign hash format instead of silently answering 'wrong password'", async () => {
		await expect(verifyPassword("x", "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA")).rejects.toThrow(/argon2/);
		await expect(verifyPassword("x", "not-a-hash")).rejects.toThrow(/scrypt\$N\$r\$p\$salt\$hash/);
	});

	it(
		"the decoy hash is a real, stable hash that no password matches",
		async () => {
			const decoy = await decoyHash();
			expect(await decoyHash()).toBe(decoy);
			expect(await verifyPassword("password", decoy)).toBe(false);
		},
		TIMEOUT,
	);
});
