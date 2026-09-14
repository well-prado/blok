/**
 * Password hashing (#1018) — `node:crypto` scrypt, and only scrypt.
 *
 * ## Why not argon2id
 *
 * argon2id is the better primitive, and every way to get it here is worse than
 * scrypt:
 *
 * - `argon2` / `@node-rs/argon2` are NATIVE ADDONS. A starter kit that fails to
 *   install on a platform without prebuilt binaries is not a starter kit.
 * - `Bun.password` has argon2id built in, but only under Bun. A project that
 *   hashes under `bun run dev` and deploys to Node could not verify a single
 *   password — the `$argon2id$` digests would be unreadable on the other side.
 *   A hash format that depends on which runtime wrote it is a trap, not a
 *   feature.
 *
 * `scrypt` is in `node:crypto`, is implemented identically by Bun, Node and
 * Deno, and is an accepted password hash (RFC 7914; OWASP lists it alongside
 * argon2id). So the kit hashes with scrypt everywhere, and a project that wants
 * argon2id installs its own hasher and stores the digest through the same
 * `UserStore` — nothing here inspects the string except {@link verifyPassword}.
 *
 * ## Parameters
 *
 * `N=32768, r=8, p=1, keylen=64` — 32 MiB and roughly 100 ms per hash on a 2024
 * laptop core. That is OWASP's `2^15/8/1` scrypt row: the point of a memory-hard
 * KDF is to make an offline dictionary attack pay for RAM, and 32 MiB per guess
 * does that without letting a login route become a memory DoS. `maxmem` is set
 * to twice the working set because Node's 32 MiB default would reject `N=32768`
 * outright.
 *
 * ## Format
 *
 * `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>` — self-describing, so raising the
 * cost later still verifies every existing password with the parameters it was
 * written with.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
	password: string | Buffer,
	salt: string | Buffer,
	keylen: number,
	options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Work factors. Tune `cost` upward as hardware improves — old hashes still verify. */
export interface ScryptParams {
	/** CPU/memory cost, a power of two. Default 32768 (2^15) ≈ 32 MiB. */
	N: number;
	/** Block size. Default 8. */
	r: number;
	/** Parallelism. Default 1. */
	p: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { N: 32768, r: 8, p: 1 };

/** Derived key length in bytes. */
const KEYLEN = 64;

/** Salt length in bytes — 16 is the floor for a per-user salt. */
const SALT_BYTES = 16;

function maxmem(params: ScryptParams): number {
	// Node's default cap is 32 MiB, which `N=32768, r=8` (32 MiB working set)
	// bumps into. Double it so the default parameters are usable at all.
	return 2 * 128 * params.N * params.r;
}

/**
 * Hash a password. Async on purpose: scrypt is deliberately slow, and the
 * synchronous variant would block the event loop for every concurrent login.
 *
 * @throws on an empty password — that is a validation bug upstream, and a hash
 * of `""` is a password anyone can guess.
 */
export async function hashPassword(password: string, params: Partial<ScryptParams> = {}): Promise<string> {
	if (typeof password !== "string" || password.length === 0) {
		throw new Error("@blokjs/auth: hashPassword() requires a non-empty password.");
	}
	const { N, r, p } = { ...DEFAULT_SCRYPT, ...params };
	const salt = randomBytes(SALT_BYTES);
	const derived = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: maxmem({ N, r, p }) });
	return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Check a password against a stored hash. Constant-time in the digest
 * comparison, and `false` (never a throw) for a wrong password.
 *
 * @throws when `stored` is not a hash this module wrote. A malformed row is a
 * server-side problem — reporting it as "wrong password" would hide a broken
 * migration behind a login screen nobody can get past.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parsed = parseHash(stored);
	const derived = await scrypt(password, parsed.salt, parsed.digest.length, {
		N: parsed.N,
		r: parsed.r,
		p: parsed.p,
		maxmem: maxmem(parsed),
	});
	return derived.length === parsed.digest.length && timingSafeEqual(derived, parsed.digest);
}

interface ParsedHash extends ScryptParams {
	salt: Buffer;
	digest: Buffer;
}

function parseHash(stored: string): ParsedHash {
	const parts = typeof stored === "string" ? stored.split("$") : [];
	const [scheme, n, r, p, salt, digest] = parts;
	if (parts.length !== 6 || scheme !== "scrypt") {
		throw new Error(
			`@blokjs/auth: unrecognised password hash format${
				typeof stored === "string" && stored.startsWith("$argon2")
					? " — this looks like an argon2 digest, which this kit cannot verify"
					: ""
			}. Expected \`scrypt$N$r$p$salt$hash\`.\nFix: re-hash the password with hashPassword(), or plug your own hasher in and keep its digests out of verifyPassword().`,
		);
	}
	const params = { N: Number(n), r: Number(r), p: Number(p) };
	if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) {
		throw new Error("@blokjs/auth: password hash carries non-numeric scrypt parameters.");
	}
	return {
		...params,
		salt: Buffer.from(salt as string, "base64"),
		digest: Buffer.from(digest as string, "base64"),
	};
}

/**
 * A hash of a value nobody knows, used to spend the same time on a login for an
 * address that does not exist as on one that does. Without it, response time
 * alone enumerates registered users.
 *
 * Computed once, lazily, with the default parameters — the cost that matters is
 * the VERIFY, and that is paid per attempt either way.
 */
let decoy: Promise<string> | undefined;

export function decoyHash(): Promise<string> {
	decoy ??= hashPassword(randomBytes(32).toString("base64url"));
	return decoy;
}
