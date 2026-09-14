/**
 * Password-reset tokens (#1018): single-use, expiring, and keyed.
 *
 * The raw token is 32 random bytes, base64url — it exists in the reset link and
 * nowhere else. What the store holds is `HMAC-SHA256(token, secret)`:
 *
 * - **hashed at rest** so a leaked users table cannot be turned into working
 *   reset links,
 * - **keyed** (HMAC rather than a bare SHA-256) so an attacker who can write
 *   rows still cannot mint one without `BLOK_SESSION_SECRET`,
 * - **single-use** because {@link consumeResetToken} deletes before it checks
 *   anything — a replay finds nothing,
 * - **expiring** at `resetTokenTtl` (default one hour), enforced on consume as
 *   well as by the sweep.
 *
 * There is no separate signature on the token itself: the value is already 256
 * bits of randomness that has to match a stored row, so a signature would only
 * re-state what the lookup proves.
 */

import { createHmac, randomBytes } from "node:crypto";
import { resolveSessionSecret } from "@blokjs/session";
import { authOptions, getUserStore } from "./config.js";
import { normalizeEmail } from "./user-store.js";

/** `HMAC-SHA256(token, secret)`, base64url — what the store sees. */
export function hashResetToken(token: string, secret?: string): string {
	return createHmac("sha256", resolveSessionSecret(secret ?? authOptions().secret))
		.update(token)
		.digest("base64url");
}

/**
 * Issue a reset token for `email`.
 *
 * Returns `undefined` when no account matches — the CALLER must still answer
 * "if that address exists we sent a link", or the form becomes an account
 * enumeration oracle.
 */
export async function createResetToken(email: string): Promise<{ token: string; userId: string } | undefined> {
	const user = await getUserStore().findByEmail(normalizeEmail(email));
	if (!user) return undefined;
	const token = randomBytes(32).toString("base64url");
	await getUserStore().createResetToken({
		userId: user.id,
		tokenHash: hashResetToken(token),
		expiresAt: Date.now() + authOptions().resetTokenTtl * 1000,
	});
	return { token, userId: user.id };
}

/**
 * Spend a reset token. Returns the owning user id, or `undefined` when the
 * token is unknown, already used, or expired — the three cases are deliberately
 * indistinguishable to the caller and to the user.
 */
export async function consumeResetToken(token: string): Promise<string | undefined> {
	if (typeof token !== "string" || token.length === 0) return undefined;
	const consumed = await getUserStore().consumeResetToken(hashResetToken(token));
	return consumed?.userId;
}
