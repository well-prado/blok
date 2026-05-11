/**
 * Webhook signature verifiers — one strategy per supported provider.
 *
 * Each verifier reads the raw request bytes (NOT the JSON-parsed body)
 * and the provider-specific signature header, computes the expected
 * HMAC against a shared secret, and constant-time compares. On match,
 * returns `{ ok: true, eventId, eventType }`. On mismatch / missing
 * header / drift, returns `{ ok: false, reason, message }`.
 *
 * Constant-time comparison via `crypto.timingSafeEqual` is mandatory —
 * a naive `===` compare leaks the expected HMAC byte by byte through
 * timing variance and a network-adjacent attacker can recover the
 * secret in ~256 requests per byte.
 *
 * Built-in providers + their signature shapes:
 *
 *   - **github**:    `X-Hub-Signature-256: sha256=<hex>` over rawBody.
 *                    Event id from `X-GitHub-Delivery`; event type
 *                    from `X-GitHub-Event` header.
 *   - **stripe**:    `Stripe-Signature: t=<ts>,v1=<hex>` over
 *                    `<ts>.<rawBody>` with a 5-minute drift window.
 *                    Event id + type from body.id / body.type.
 *   - **slack**:     `X-Slack-Signature: v0=<hex>` over
 *                    `v0:<X-Slack-Request-Timestamp>:<rawBody>` with a
 *                    5-minute drift window. Event type from
 *                    body.event.type; event id from body.event_id.
 *   - **shopify**:   `X-Shopify-Hmac-Sha256: <base64>` over rawBody.
 *                    Event type from `X-Shopify-Topic`; event id from
 *                    `X-Shopify-Webhook-Id`.
 *   - **svix**:      Standard Webhooks. `webhook-signature:
 *                    v1,<base64>` over `<webhook-id>.<webhook-timestamp>.<rawBody>`
 *                    with a 5-minute drift window. Event id from
 *                    `webhook-id`; event type from body.type.
 *
 * Custom (unknown provider) verifier is built dynamically by
 * `buildCustomVerifier()` from the workflow's `signature` config.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Successful verification result — workflow may proceed. */
export interface VerifyOk {
	ok: true;
	/** Provider-specific event id (used for replay-protection cache key). */
	eventId: string;
	/** Provider-specific event type (used for the allowlist check). */
	eventType: string;
}

/** Verification failure — trigger returns 401 with structured reason. */
export interface VerifyError {
	ok: false;
	/** Stable discriminator — log/alert dashboards branch on this. */
	reason:
		| "missing_signature"
		| "missing_timestamp"
		| "missing_secret"
		| "bad_format"
		| "timestamp_drift"
		| "signature_mismatch";
	/** Human-readable error message. Safe to surface to the sender. */
	message: string;
}

export type VerifyResult = VerifyOk | VerifyError;

/** Inputs every verifier receives. */
export interface VerifyInput {
	headers: Record<string, string>;
	rawBody: string;
	parsedBody: unknown;
	secret: string;
	toleranceSec: number;
}

export interface Verifier {
	verify(input: VerifyInput): VerifyResult;
}

const DEFAULT_TOLERANCE_SEC = 300;

function safeEqualString(a: string, b: string): boolean {
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}

function hmacHex(algo: "sha256" | "sha1" | "sha512", secret: string, data: string): string {
	return createHmac(algo, secret).update(data).digest("hex");
}

function hmacBase64(algo: "sha256" | "sha1" | "sha512", secret: string, data: string): string {
	return createHmac(algo, secret).update(data).digest("base64");
}

function isWithinTolerance(timestampSec: number, toleranceSec: number): boolean {
	const nowSec = Math.floor(Date.now() / 1000);
	return Math.abs(nowSec - timestampSec) <= toleranceSec;
}

function getEventTypeFromBody(parsedBody: unknown, key = "type"): string | undefined {
	if (!parsedBody || typeof parsedBody !== "object") return undefined;
	const value = (parsedBody as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

// =============================================================================
// Built-in providers
// =============================================================================

export const githubVerifier: Verifier = {
	verify({ headers, rawBody, secret }) {
		if (!secret) return { ok: false, reason: "missing_secret", message: "GitHub: secret not configured" };
		const sig = headers["x-hub-signature-256"];
		if (!sig) return { ok: false, reason: "missing_signature", message: "GitHub: X-Hub-Signature-256 header missing" };
		const expected = `sha256=${hmacHex("sha256", secret, rawBody)}`;
		if (!safeEqualString(sig, expected)) {
			return { ok: false, reason: "signature_mismatch", message: "GitHub: signature mismatch" };
		}
		return {
			ok: true,
			eventId: headers["x-github-delivery"] ?? "",
			eventType: headers["x-github-event"] ?? "unknown",
		};
	},
};

export const stripeVerifier: Verifier = {
	verify({ headers, rawBody, parsedBody, secret, toleranceSec }) {
		if (!secret) return { ok: false, reason: "missing_secret", message: "Stripe: secret not configured" };
		const sig = headers["stripe-signature"];
		if (!sig) return { ok: false, reason: "missing_signature", message: "Stripe: Stripe-Signature header missing" };

		// Format: t=1234567890,v1=<hex>,v0=<hex>,...
		const parts = Object.fromEntries(
			sig
				.split(",")
				.map((p) => p.trim())
				.map((p) => {
					const idx = p.indexOf("=");
					return idx === -1 ? [p, ""] : [p.slice(0, idx), p.slice(idx + 1)];
				}),
		);
		const ts = parts.t;
		const v1 = parts.v1;
		if (!ts || !v1) {
			return {
				ok: false,
				reason: "bad_format",
				message: "Stripe: signature missing t= or v1= component",
			};
		}
		const tsNum = Number.parseInt(ts, 10);
		if (!Number.isFinite(tsNum)) {
			return { ok: false, reason: "bad_format", message: "Stripe: t= is not numeric" };
		}
		if (!isWithinTolerance(tsNum, toleranceSec || DEFAULT_TOLERANCE_SEC)) {
			return {
				ok: false,
				reason: "timestamp_drift",
				message: `Stripe: timestamp drift exceeds ${toleranceSec || DEFAULT_TOLERANCE_SEC}s tolerance`,
			};
		}
		const expected = hmacHex("sha256", secret, `${ts}.${rawBody}`);
		if (!safeEqualString(v1, expected)) {
			return { ok: false, reason: "signature_mismatch", message: "Stripe: signature mismatch" };
		}
		const eventId = (parsedBody as { id?: unknown } | null)?.id;
		const eventType = getEventTypeFromBody(parsedBody);
		return {
			ok: true,
			eventId: typeof eventId === "string" ? eventId : "",
			eventType: eventType ?? "unknown",
		};
	},
};

export const slackVerifier: Verifier = {
	verify({ headers, rawBody, parsedBody, secret, toleranceSec }) {
		if (!secret) return { ok: false, reason: "missing_secret", message: "Slack: secret not configured" };
		const sig = headers["x-slack-signature"];
		if (!sig) return { ok: false, reason: "missing_signature", message: "Slack: X-Slack-Signature header missing" };
		const ts = headers["x-slack-request-timestamp"];
		if (!ts) {
			return {
				ok: false,
				reason: "missing_timestamp",
				message: "Slack: X-Slack-Request-Timestamp header missing",
			};
		}
		const tsNum = Number.parseInt(ts, 10);
		if (!Number.isFinite(tsNum)) {
			return { ok: false, reason: "bad_format", message: "Slack: timestamp is not numeric" };
		}
		if (!isWithinTolerance(tsNum, toleranceSec || DEFAULT_TOLERANCE_SEC)) {
			return {
				ok: false,
				reason: "timestamp_drift",
				message: `Slack: timestamp drift exceeds ${toleranceSec || DEFAULT_TOLERANCE_SEC}s tolerance`,
			};
		}
		const expected = `v0=${hmacHex("sha256", secret, `v0:${ts}:${rawBody}`)}`;
		if (!safeEqualString(sig, expected)) {
			return { ok: false, reason: "signature_mismatch", message: "Slack: signature mismatch" };
		}
		const event = (parsedBody as { event?: { type?: unknown }; event_id?: unknown } | null) ?? {};
		const eventType = typeof event.event?.type === "string" ? event.event.type : "unknown";
		const eventId = typeof event.event_id === "string" ? event.event_id : "";
		return { ok: true, eventId, eventType };
	},
};

export const shopifyVerifier: Verifier = {
	verify({ headers, rawBody, secret }) {
		if (!secret) return { ok: false, reason: "missing_secret", message: "Shopify: secret not configured" };
		const sig = headers["x-shopify-hmac-sha256"];
		if (!sig) {
			return { ok: false, reason: "missing_signature", message: "Shopify: X-Shopify-Hmac-Sha256 header missing" };
		}
		const expected = hmacBase64("sha256", secret, rawBody);
		if (!safeEqualString(sig, expected)) {
			return { ok: false, reason: "signature_mismatch", message: "Shopify: signature mismatch" };
		}
		return {
			ok: true,
			eventId: headers["x-shopify-webhook-id"] ?? "",
			eventType: headers["x-shopify-topic"] ?? "unknown",
		};
	},
};

export const svixVerifier: Verifier = {
	verify({ headers, rawBody, parsedBody, secret, toleranceSec }) {
		if (!secret) return { ok: false, reason: "missing_secret", message: "Svix: secret not configured" };
		const webhookId = headers["webhook-id"];
		const webhookTs = headers["webhook-timestamp"];
		const webhookSig = headers["webhook-signature"];
		if (!webhookId || !webhookTs || !webhookSig) {
			return {
				ok: false,
				reason: "missing_signature",
				message: "Svix/Standard Webhooks: missing webhook-id, webhook-timestamp, or webhook-signature header",
			};
		}
		const tsNum = Number.parseInt(webhookTs, 10);
		if (!Number.isFinite(tsNum)) {
			return { ok: false, reason: "bad_format", message: "Svix: webhook-timestamp is not numeric" };
		}
		if (!isWithinTolerance(tsNum, toleranceSec || DEFAULT_TOLERANCE_SEC)) {
			return {
				ok: false,
				reason: "timestamp_drift",
				message: `Svix: timestamp drift exceeds ${toleranceSec || DEFAULT_TOLERANCE_SEC}s tolerance`,
			};
		}
		const signed = `${webhookId}.${webhookTs}.${rawBody}`;
		// Strip optional `whsec_` prefix Svix recommends for secrets.
		const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
		// Svix encodes the secret as base64 — decode before HMAC.
		const secretBuf = Buffer.from(rawSecret, "base64");
		const expected = createHmac("sha256", secretBuf).update(signed).digest("base64");
		// webhook-signature may include multiple versions: `v1,base64 v1,base64 ...`
		const sigs = webhookSig.split(" ").map((s) => {
			const idx = s.indexOf(",");
			return idx === -1 ? s : s.slice(idx + 1);
		});
		const matched = sigs.some((s) => safeEqualString(s, expected));
		if (!matched) {
			return { ok: false, reason: "signature_mismatch", message: "Svix: signature mismatch" };
		}
		return {
			ok: true,
			eventId: webhookId,
			eventType: getEventTypeFromBody(parsedBody) ?? "unknown",
		};
	},
};

// =============================================================================
// Custom verifier — built from the workflow's `signature: { ... }` config
// =============================================================================

export interface CustomSignatureConfig {
	scheme: "hmac-sha256" | "hmac-sha1" | "hmac-sha512";
	header: string;
	format: string;
	secretEnv: string;
	tolerance: number;
	timestampHeader?: string;
}

export function buildCustomVerifier(config: CustomSignatureConfig): Verifier {
	const algo: "sha256" | "sha1" | "sha512" =
		config.scheme === "hmac-sha1" ? "sha1" : config.scheme === "hmac-sha512" ? "sha512" : "sha256";
	const headerLower = config.header.toLowerCase();
	const tsHeaderLower = config.timestampHeader?.toLowerCase();

	return {
		verify({ headers, rawBody, parsedBody, secret, toleranceSec }) {
			if (!secret) return { ok: false, reason: "missing_secret", message: `${config.header}: secret not configured` };
			const sig = headers[headerLower];
			if (!sig) {
				return { ok: false, reason: "missing_signature", message: `${config.header}: header missing` };
			}

			let signedString = rawBody;
			if (tsHeaderLower) {
				const ts = headers[tsHeaderLower];
				if (!ts) {
					return {
						ok: false,
						reason: "missing_timestamp",
						message: `${config.timestampHeader}: header missing`,
					};
				}
				const tsNum = Number.parseInt(ts, 10);
				if (!Number.isFinite(tsNum)) {
					return {
						ok: false,
						reason: "bad_format",
						message: `${config.timestampHeader}: not numeric`,
					};
				}
				if (!isWithinTolerance(tsNum, toleranceSec || config.tolerance)) {
					return {
						ok: false,
						reason: "timestamp_drift",
						message: `Timestamp drift exceeds ${toleranceSec || config.tolerance}s tolerance`,
					};
				}
				signedString = `${ts}.${rawBody}`;
			}

			const hex = hmacHex(algo, secret, signedString);
			const base64 = hmacBase64(algo, secret, signedString);
			const expected = config.format.replace("{hex}", hex).replace("{base64}", base64);

			if (!safeEqualString(sig, expected)) {
				return { ok: false, reason: "signature_mismatch", message: `${config.header}: signature mismatch` };
			}
			return {
				ok: true,
				eventId: "",
				eventType: getEventTypeFromBody(parsedBody) ?? "unknown",
			};
		},
	};
}

export const BUILTIN_VERIFIERS: Record<string, Verifier> = {
	github: githubVerifier,
	stripe: stripeVerifier,
	slack: slackVerifier,
	shopify: shopifyVerifier,
	svix: svixVerifier,
};
