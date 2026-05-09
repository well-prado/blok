import { createHmac, timingSafeEqual } from "node:crypto";
import { defineNode } from "@blokjs/runner";
import { GlobalError } from "@blokjs/shared";
import { z } from "zod";

/**
 * Verify an HMAC signature on a payload — the canonical primitive for
 * webhook authenticity (GitHub `X-Hub-Signature-256`, Stripe
 * `Stripe-Signature`, Slack `X-Slack-Signature`, etc.). Compares the
 * supplied signature against an HMAC of the payload computed with a
 * shared secret. On mismatch, throws `GlobalError(401)` with a
 * structured `reason` discriminator so a `tryCatch.catch` arm can
 * branch on the failure mode.
 *
 * The signature comparison uses `crypto.timingSafeEqual` to prevent
 * timing-attack leaks of the expected HMAC. Without this, a remote
 * attacker can statistically discover the secret one byte at a time.
 *
 * @example GitHub webhook (X-Hub-Signature-256, sha256=<hex>):
 *   ```json
 *   {
 *     "id": "verify",
 *     "use": "@blokjs/hmac-verify",
 *     "inputs": {
 *       "signature": "js/ctx.request.headers['x-hub-signature-256']",
 *       "payload":   "js/JSON.stringify(ctx.request.body)",
 *       "secret":    "js/ctx.env.GITHUB_WEBHOOK_SECRET",
 *       "prefix":    "sha256="
 *     }
 *   }
 *   ```
 *
 * @example Stripe webhook (Stripe-Signature with timestamp prefix):
 *   The shipped helper compares the raw HMAC; for Stripe's `t=...,v1=...`
 *   format you'd parse the components in an upstream `@blokjs/expr`
 *   step before passing the inner v1 hex into `signature`. Same shape,
 *   different glue.
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

const inputSchema = z.object({
	signature: z
		.string()
		.describe(
			"The signature value extracted from the request (e.g. the X-Hub-Signature-256 header for GitHub). " +
				"Empty strings are accepted at validation time and rejected as 401 reason=missing_signature at " +
				"runtime — surfaces 'no signature header' as an auth failure (not a 400 request-validation failure).",
		),
	payload: z
		.string()
		.describe(
			"The raw payload string the signature was computed over. Typically the JSON-serialised request " +
				"body (`JSON.stringify(ctx.request.body)`). For providers that sign the raw bytes (Stripe, etc.), " +
				"upstream middleware needs to capture the raw body before JSON.parse — Blok's HTTP trigger " +
				"currently only exposes parsed JSON, so the demo signs the re-stringified body. Production " +
				"deployments that need byte-exact signing should add a raw-body capture middleware before this step.",
		),
	secret: z
		.string()
		.describe(
			"Shared secret. Source from a secrets manager via env (`js/ctx.env.GITHUB_WEBHOOK_SECRET`); never " +
				"inline in the workflow JSON. The helper does not log the secret on failure paths.",
		),
	algorithm: z
		.enum(["sha256", "sha384", "sha512", "sha1"])
		.optional()
		.describe(
			"HMAC algorithm. Default sha256 (GitHub, Slack, most modern webhooks). sha1 is included for legacy " +
				"providers (older GitHub `X-Hub-Signature` without -256, etc.) but is otherwise discouraged.",
		),
	prefix: z
		.string()
		.optional()
		.describe(
			"Optional prefix that the supplied signature value carries (e.g. `sha256=` for GitHub, `v1=` for " +
				"Stripe payloads after their `t=...,v1=...` is split). The helper strips this prefix before " +
				"the timing-safe compare. Default empty string — the signature is treated as raw hex.",
		),
});

const outputSchema = z.object({
	verified: z.literal(true),
	algorithm: z.string(),
	signatureLength: z.number(),
});

export default defineNode({
	name: "@blokjs/hmac-verify",
	description:
		"Verify an HMAC signature on a payload. Production-grade webhook auth (GitHub / Stripe / Slack patterns). Throws GlobalError(401) with a structured reason on any verification failure; uses timing-safe compare to prevent secret leaks.",
	input: inputSchema,
	output: outputSchema,

	async execute(_ctx, input) {
		// Reject empty inputs explicitly with the most useful reasons —
		// schema-level rejection would surface as 400 (validation failure)
		// instead of 401 (auth failure), which is wrong for these cases.
		if (input.signature.trim().length === 0) {
			throw unauthorized("missing_signature", "No signature was provided");
		}
		if (input.secret.length === 0) {
			throw unauthorized("misconfigured", "HMAC secret is empty — set the secret env var on the server");
		}

		const algorithm = input.algorithm ?? "sha256";
		const prefix = input.prefix ?? "";

		// Strip the prefix if present. If the prefix is set but the
		// signature doesn't carry it, that's a malformed signature.
		let supplied = input.signature;
		if (prefix.length > 0) {
			if (!supplied.startsWith(prefix)) {
				throw unauthorized("malformed_signature", `Signature is missing the expected '${prefix}' prefix`);
			}
			supplied = supplied.slice(prefix.length);
		}

		// Compute the expected HMAC over the payload.
		const expected = createHmac(algorithm, input.secret).update(input.payload).digest("hex");

		// Length-mismatched buffers in timingSafeEqual throw RangeError;
		// catch it as a structured 401 instead of a generic crash. A wrong
		// algorithm choice (sha1 vs sha256) would manifest here.
		if (supplied.length !== expected.length) {
			throw unauthorized(
				"invalid_signature",
				`Signature length mismatch (got ${supplied.length} chars, expected ${expected.length})`,
			);
		}

		// timingSafeEqual rejects if either buffer can't be decoded as
		// hex — so a non-hex signature also surfaces as invalid_signature.
		let suppliedBuf: Buffer;
		let expectedBuf: Buffer;
		try {
			suppliedBuf = Buffer.from(supplied, "hex");
			expectedBuf = Buffer.from(expected, "hex");
			// Buffer.from with bad hex SILENTLY truncates rather than throwing,
			// so re-check length after decode.
			if (suppliedBuf.length !== expectedBuf.length || suppliedBuf.length === 0) {
				throw unauthorized("invalid_signature", "Signature is not valid hex");
			}
		} catch (err) {
			if (err instanceof GlobalError) throw err;
			throw unauthorized("invalid_signature", "Signature is not valid hex");
		}

		if (!timingSafeEqual(suppliedBuf, expectedBuf)) {
			throw unauthorized("invalid_signature", "HMAC signature verification failed");
		}

		return {
			verified: true as const,
			algorithm,
			signatureLength: supplied.length,
		};
	},
});
