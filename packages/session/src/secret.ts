/**
 * The session signing secret (#1018).
 *
 * Same contract as `resolveFlashSecret()` in `@blokjs/shared`: the env var or
 * an explicit override, and a HARD ERROR otherwise. A random fallback would
 * invalidate every session on restart; a constant one would let anyone forge a
 * session cookie, which here means logging in as any user.
 */

/** Env var holding the session-cookie signing secret. Required — there is NO fallback. */
export const SESSION_SECRET_ENV = "BLOK_SESSION_SECRET";

/**
 * Shortest secret accepted. 16 bytes is the floor below which an HMAC key is
 * brute-forceable offline from a single observed cookie — and a forged session
 * cookie is a full account takeover, so this is a boot error rather than a
 * warning.
 */
const MIN_SECRET_LENGTH = 16;

/**
 * Resolve the signing secret: the explicit argument, else `BLOK_SESSION_SECRET`.
 *
 * @throws naming the variable, with a `Fix:` line, when it is missing or too short.
 */
export function resolveSessionSecret(explicit?: string): string {
	const secret = explicit ?? process.env[SESSION_SECRET_ENV];
	if (!secret) {
		throw new Error(
			`[blok] @blokjs/session: ${SESSION_SECRET_ENV} is not set, and session cookies cannot be signed without it. There is no default — an unsigned or randomly-keyed session cookie is forgeable, which means signing in as any user.\nFix: set ${SESSION_SECRET_ENV} to at least ${MIN_SECRET_LENGTH} characters of random data, e.g. \`${SESSION_SECRET_ENV}=$(openssl rand -base64 32)\` (see .env.example).`,
		);
	}
	if (secret.length < MIN_SECRET_LENGTH) {
		throw new Error(
			`[blok] @blokjs/session: ${SESSION_SECRET_ENV} is only ${secret.length} characters long; an HMAC key that short is brute-forceable from one observed cookie.\n` +
				`Fix: set ${SESSION_SECRET_ENV} to at least ${MIN_SECRET_LENGTH} characters, e.g. \`${SESSION_SECRET_ENV}=$(openssl rand -base64 32)\`.`,
		);
	}
	return secret;
}
