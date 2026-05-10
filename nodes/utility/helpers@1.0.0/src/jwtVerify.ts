import { defineNode } from "@blokjs/runner";
import { GlobalError } from "@blokjs/shared";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import { z } from "zod";

/**
 * Verify a JSON Web Token, with iss/aud/exp validation, against either a
 * shared HMAC secret (HS256/HS384/HS512), a static asymmetric public key
 * (RS256/ES256/EdDSA), or a remote JWKS endpoint (the production case for
 * Auth0 / Okta / Cognito / Clerk / etc.). On success, surfaces the decoded
 * claims at the step's output so middleware can stash them on
 * `ctx.state.identity` for downstream steps.
 *
 * Failure modes ALWAYS produce a structured `GlobalError(401)` with a
 * specific `reason` field — token expired, invalid signature, issuer
 * mismatch, audience mismatch, malformed token, missing token. The
 * `code: 401` propagates through `defineNode.mapErrorToGlobalError` →
 * `RunnerSteps` → trigger response handler, so the HTTP response is an
 * actual 401 with a structured JSON body. Authors can read `$.error.code
 * === 401` and `$.error.message` inside a `tryCatch.catch` arm to
 * branch on auth failures specifically.
 *
 * Configuration is split between **what comes in via inputs** (token,
 * algorithm allowlist, issuer, audience) and **how the key is sourced**.
 * Pick exactly one of `secret`, `publicKey`, or `jwksUri`. The middleware
 * workflow that wraps this node typically resolves these from env vars
 * (`JWT_SECRET`, `JWT_JWKS_URI`, etc.) so deploy-time secrets never live
 * in the workflow JSON.
 *
 * @example
 *   ```json
 *   {
 *     "id": "verify",
 *     "use": "@blokjs/jwt-verify",
 *     "inputs": {
 *       "token": "js/(ctx.request.headers.authorization || '').replace(/^Bearer\\s+/i, '')",
 *       "secret": "js/ctx.env.JWT_SECRET",
 *       "issuer": "https://my-issuer.example.com",
 *       "audience": "my-api"
 *     }
 *   }
 *   ```
 */

/** Build a structured 401 GlobalError with a stable `reason` discriminator. */
function unauthorized(reason: string, message: string): GlobalError {
	const err = new GlobalError(message);
	err.setCode(401);
	err.setName("UnauthorizedError");
	(err as Error).name = "UnauthorizedError";
	err.setJson({
		error: "Unauthorized",
		reason,
		message,
	});
	return err;
}

/**
 * Translate a `jose` library error into a structured `unauthorized()` so
 * the catch arm sees a stable `reason` field (rather than jose's
 * implementation-specific class names). Centralized here so any future
 * add of a verify path (e.g. encrypted JWE, JWS multi-recipient) routes
 * through the same translation.
 */
function joseErrorToUnauthorized(err: unknown): GlobalError {
	if (err instanceof joseErrors.JWTExpired) {
		return unauthorized("token_expired", "Token has expired");
	}
	if (err instanceof joseErrors.JWTClaimValidationFailed) {
		const claim = (err as joseErrors.JWTClaimValidationFailed).claim;
		if (claim === "iss") return unauthorized("issuer_mismatch", "Token issuer does not match expected");
		if (claim === "aud") return unauthorized("audience_mismatch", "Token audience does not match expected");
		if (claim === "nbf") return unauthorized("token_not_yet_valid", "Token is not yet valid");
		return unauthorized("claim_validation_failed", `Token claim '${claim}' validation failed`);
	}
	if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
		return unauthorized("invalid_signature", "Token signature verification failed");
	}
	if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
		return unauthorized("malformed_token", "Token is malformed");
	}
	if (err instanceof joseErrors.JOSEAlgNotAllowed) {
		return unauthorized("algorithm_not_allowed", "Token uses a non-allowed algorithm");
	}
	// Unknown failure — keep the message but tag with a generic reason
	// so dashboards can still group these without leaking internals.
	const msg = err instanceof Error ? err.message : String(err);
	return unauthorized("verification_failed", msg);
}

const inputSchema = z
	.object({
		token: z
			.string()
			.describe(
				"The bearer token to verify (already stripped of 'Bearer ' prefix). " +
					"Empty strings are accepted at validation time and rejected as a 401 with " +
					"reason=missing_token at runtime — this surfaces 'no auth header' as an " +
					"auth failure, not a request-validation failure (which would be 400).",
			),
		algorithms: z
			.array(z.string().min(1))
			.optional()
			.describe(
				"Allowed JWT signing algorithms. Default: ['RS256'] for asymmetric (publicKey/jwksUri) " +
					"and ['HS256'] for symmetric (secret). Set explicitly when supporting multiple algs " +
					"or when the issuer signs with something else (ES256, EdDSA, HS512, etc.). The 'none' " +
					"algorithm is never accepted regardless of allowlist.",
			),
		issuer: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.describe(
				"Expected `iss` claim — string for single-issuer, array for multi-issuer apps. " +
					"When omitted, issuer is not checked (NOT recommended for production).",
			),
		audience: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.describe(
				"Expected `aud` claim — string for single-audience, array when this service accepts " +
					"tokens minted for any of N audiences (e.g. internal tooling that gates on multiple APIs).",
			),
		clockToleranceSeconds: z
			.number()
			.int()
			.min(0)
			.max(300)
			.optional()
			.describe(
				"Seconds of clock skew to tolerate when checking exp/nbf. Default 0 — set to 30s if " +
					"client/server clocks routinely drift.",
			),
		// Key sources — exactly one must be set. Validated at runtime
		// since Zod's `.refine` doesn't compose cleanly with the rest.
		secret: z
			.string()
			.optional()
			.describe(
				"HMAC shared secret for HS256/HS384/HS512 verification. Mutually exclusive with " +
					"publicKey and jwksUri. Production deployments should source this from a secrets " +
					"manager via env (`js/ctx.env.JWT_SECRET`), never inline in the workflow JSON.",
			),
		publicKey: z
			.string()
			.optional()
			.describe(
				"PEM-encoded public key for RS256/ES256/EdDSA. Mutually exclusive with secret and " +
					"jwksUri. Use when the issuer publishes a single static key (rare in production — " +
					"prefer JWKS for rotation).",
			),
		jwksUri: z
			.string()
			.url()
			.optional()
			.describe(
				"Remote JWKS endpoint URL. Mutually exclusive with secret and publicKey. The " +
					"production case — fetched + cached + auto-rotates. Auth0 / Okta / Cognito / Clerk " +
					"all publish a `.well-known/jwks.json` endpoint that fits this slot directly.",
			),
	})
	.refine((v) => [v.secret, v.publicKey, v.jwksUri].filter((x) => x !== undefined).length === 1, {
		message: "Exactly one of `secret`, `publicKey`, or `jwksUri` must be set.",
	});

/**
 * Module-level cache of `createRemoteJWKSet` instances keyed by URL. The
 * jose library's JWKS handler caches keys + handles rotation internally,
 * so we want exactly ONE handler per JWKS endpoint per process — not one
 * per request. Without this cache, every request would re-fetch the
 * JWKS, which both hammers the issuer's endpoint and defeats jose's
 * built-in cache.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(uri: string): ReturnType<typeof createRemoteJWKSet> {
	let handler = jwksCache.get(uri);
	if (handler === undefined) {
		handler = createRemoteJWKSet(new URL(uri));
		jwksCache.set(uri, handler);
	}
	return handler;
}

/**
 * Test-only: clear the JWKS cache between tests so a previous test's
 * handler doesn't pin a stale fetch. NOT exported in HELPER_NODES.
 */
export function _resetJwksCacheForTests(): void {
	jwksCache.clear();
}

const outputSchema = z.object({
	claims: z.record(z.string(), z.unknown()).describe("The verified JWT payload (decoded claims)."),
	subject: z.string().optional().describe("Convenience alias for `claims.sub` when present."),
	issuer: z.string().optional().describe("Convenience alias for `claims.iss` when present."),
	audience: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe("Convenience alias for `claims.aud` when present."),
	expiresAt: z
		.number()
		.optional()
		.describe("Convenience alias for `claims.exp` (UNIX timestamp seconds) when present."),
});

export default defineNode({
	name: "@blokjs/jwt-verify",
	description:
		"Verify a JWT (HS256/RS256/ES256/EdDSA, with iss/aud/exp checks). Production-grade auth via the `jose` library — supports static keys + JWKS rotation. Throws GlobalError(401) with a structured reason on any verification failure.",
	input: inputSchema,
	output: outputSchema,

	async execute(_ctx, input) {
		// Defensive: reject empty token explicitly with the most useful
		// reason rather than letting jose throw its own less-descriptive
		// JWTInvalid for the empty-string case.
		if (input.token.trim().length === 0) {
			throw unauthorized("missing_token", "No bearer token was provided");
		}

		// Compute the verify-options once. jose's JWTVerifyOptions accepts
		// optional issuer / audience / algorithms / clockTolerance.
		const verifyOpts: Record<string, unknown> = {};
		if (input.issuer !== undefined) verifyOpts.issuer = input.issuer;
		if (input.audience !== undefined) verifyOpts.audience = input.audience;
		if (input.clockToleranceSeconds !== undefined) verifyOpts.clockTolerance = input.clockToleranceSeconds;

		try {
			let payload: Record<string, unknown>;

			if (input.secret !== undefined) {
				const key = new TextEncoder().encode(input.secret);
				const algs = input.algorithms ?? ["HS256"];
				const { payload: p } = await jwtVerify(input.token, key, {
					...verifyOpts,
					algorithms: algs,
				});
				payload = p as Record<string, unknown>;
			} else if (input.publicKey !== undefined) {
				const { importSPKI } = await import("jose");
				const algs = input.algorithms ?? ["RS256"];
				// SPKI import requires picking ONE alg up front; if the
				// caller provided multiple, use the first as the import
				// hint but still pass the full allowlist to jwtVerify.
				const importAlg = algs[0];
				const key = await importSPKI(input.publicKey, importAlg);
				const { payload: p } = await jwtVerify(input.token, key, {
					...verifyOpts,
					algorithms: algs,
				});
				payload = p as Record<string, unknown>;
			} else if (input.jwksUri !== undefined) {
				const jwks = getJwks(input.jwksUri);
				const algs = input.algorithms ?? ["RS256"];
				const { payload: p } = await jwtVerify(input.token, jwks, {
					...verifyOpts,
					algorithms: algs,
				});
				payload = p as Record<string, unknown>;
			} else {
				// Unreachable due to the schema's refine, but keeps type-
				// narrowing happy and gives a clear runtime error if the
				// validator is ever bypassed.
				throw unauthorized("misconfigured", "jwt-verify requires exactly one of `secret`, `publicKey`, or `jwksUri`");
			}

			const result = {
				claims: payload,
				subject: typeof payload.sub === "string" ? payload.sub : undefined,
				issuer: typeof payload.iss === "string" ? payload.iss : undefined,
				audience:
					typeof payload.aud === "string" || Array.isArray(payload.aud)
						? (payload.aud as string | string[])
						: undefined,
				expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
			};
			return result;
		} catch (err) {
			// Re-throw GlobalErrors verbatim so unauthorized()-shaped
			// failures from this function propagate intact.
			if (err instanceof GlobalError) throw err;
			throw joseErrorToUnauthorized(err);
		}
	},
});
