/**
 * Verifier unit tests — one suite per built-in provider plus the
 * custom HMAC builder. Each suite covers: happy-path verification,
 * signature mismatch, missing signature header, and (for providers
 * with timestamp-bound signing) clock drift rejection.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
	buildCustomVerifier,
	githubVerifier,
	shopifyVerifier,
	slackVerifier,
	stripeVerifier,
	svixVerifier,
} from "./verifiers";

const SECRET = "shhh-its-a-secret-1234567890";

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function hmacHex(data: string, secret = SECRET): string {
	return createHmac("sha256", secret).update(data).digest("hex");
}

function hmacBase64(data: string, secret = SECRET): string {
	return createHmac("sha256", secret).update(data).digest("base64");
}

describe("githubVerifier", () => {
	const body = JSON.stringify({ ref: "refs/heads/main", action: "opened" });

	it("accepts a valid X-Hub-Signature-256 over rawBody", () => {
		const result = githubVerifier.verify({
			headers: {
				"x-hub-signature-256": `sha256=${hmacHex(body)}`,
				"x-github-event": "push",
				"x-github-delivery": "delivery-uuid-1",
			},
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.eventId).toBe("delivery-uuid-1");
			expect(result.eventType).toBe("push");
		}
	});

	it("rejects on signature mismatch", () => {
		const result = githubVerifier.verify({
			headers: { "x-hub-signature-256": "sha256=deadbeef" },
			rawBody: body,
			parsedBody: {},
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("signature_mismatch");
	});

	it("rejects when X-Hub-Signature-256 header is missing", () => {
		const result = githubVerifier.verify({
			headers: {},
			rawBody: body,
			parsedBody: {},
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_signature");
	});
});

describe("stripeVerifier", () => {
	const body = JSON.stringify({ id: "evt_123", type: "invoice.paid" });

	it("accepts a valid Stripe-Signature within tolerance", () => {
		const ts = String(nowSec());
		const sig = hmacHex(`${ts}.${body}`);
		const result = stripeVerifier.verify({
			headers: { "stripe-signature": `t=${ts},v1=${sig}` },
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.eventId).toBe("evt_123");
			expect(result.eventType).toBe("invoice.paid");
		}
	});

	it("rejects timestamps outside the tolerance window", () => {
		const ts = String(nowSec() - 10_000);
		const sig = hmacHex(`${ts}.${body}`);
		const result = stripeVerifier.verify({
			headers: { "stripe-signature": `t=${ts},v1=${sig}` },
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("timestamp_drift");
	});

	it("rejects on signature mismatch", () => {
		const ts = String(nowSec());
		const result = stripeVerifier.verify({
			headers: { "stripe-signature": `t=${ts},v1=ffffffff` },
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("signature_mismatch");
	});

	it("rejects when t= or v1= component is missing", () => {
		const result = stripeVerifier.verify({
			headers: { "stripe-signature": "v1=abc" },
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("bad_format");
	});
});

describe("slackVerifier", () => {
	const body = JSON.stringify({ event: { type: "message" }, event_id: "Ev123" });

	it("accepts a valid X-Slack-Signature", () => {
		const ts = String(nowSec());
		const sig = `v0=${hmacHex(`v0:${ts}:${body}`)}`;
		const result = slackVerifier.verify({
			headers: {
				"x-slack-signature": sig,
				"x-slack-request-timestamp": ts,
			},
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.eventId).toBe("Ev123");
			expect(result.eventType).toBe("message");
		}
	});

	it("rejects when X-Slack-Request-Timestamp header is missing", () => {
		const result = slackVerifier.verify({
			headers: { "x-slack-signature": "v0=abc" },
			rawBody: body,
			parsedBody: {},
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_timestamp");
	});
});

describe("shopifyVerifier", () => {
	const body = JSON.stringify({ id: 999, line_items: [] });

	it("accepts a valid base64 X-Shopify-Hmac-Sha256", () => {
		const result = shopifyVerifier.verify({
			headers: {
				"x-shopify-hmac-sha256": hmacBase64(body),
				"x-shopify-topic": "orders/create",
				"x-shopify-webhook-id": "shopify-webhook-1",
			},
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.eventId).toBe("shopify-webhook-1");
			expect(result.eventType).toBe("orders/create");
		}
	});

	it("rejects on signature mismatch", () => {
		const result = shopifyVerifier.verify({
			headers: { "x-shopify-hmac-sha256": "deadbeef==" },
			rawBody: body,
			parsedBody: {},
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("signature_mismatch");
	});
});

describe("svixVerifier (Standard Webhooks)", () => {
	const body = JSON.stringify({ type: "user.created", data: { id: "user_42" } });
	// Svix expects the secret base64-decoded — encode our test secret first.
	const svixSecret = Buffer.from(SECRET).toString("base64");

	it("accepts a valid webhook-signature (v1 scheme)", () => {
		const webhookId = "msg_abc";
		const webhookTs = String(nowSec());
		const signed = `${webhookId}.${webhookTs}.${body}`;
		const expected = createHmac("sha256", Buffer.from(svixSecret, "base64")).update(signed).digest("base64");
		const result = svixVerifier.verify({
			headers: {
				"webhook-id": webhookId,
				"webhook-timestamp": webhookTs,
				"webhook-signature": `v1,${expected}`,
			},
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: svixSecret,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.eventId).toBe(webhookId);
			expect(result.eventType).toBe("user.created");
		}
	});

	it("rejects when any of the three headers is missing", () => {
		const result = svixVerifier.verify({
			headers: { "webhook-id": "msg", "webhook-timestamp": String(nowSec()) },
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: svixSecret,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_signature");
	});
});

describe("buildCustomVerifier (custom signature scheme)", () => {
	const body = JSON.stringify({ type: "ping" });

	it("accepts a valid signature with `{hex}` format placeholder", () => {
		const verifier = buildCustomVerifier({
			scheme: "hmac-sha256",
			header: "X-Acme-Signature",
			format: "sha256={hex}",
			secretEnv: "ACME_SECRET",
			tolerance: 300,
		});
		const result = verifier.verify({
			headers: { "x-acme-signature": `sha256=${hmacHex(body)}` },
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
	});

	it("accepts a valid signature with timestamp + tolerance", () => {
		const verifier = buildCustomVerifier({
			scheme: "hmac-sha256",
			header: "X-Acme-Signature",
			format: "{hex}",
			secretEnv: "ACME_SECRET",
			tolerance: 300,
			timestampHeader: "X-Acme-Timestamp",
		});
		const ts = String(nowSec());
		const sig = hmacHex(`${ts}.${body}`);
		const result = verifier.verify({
			headers: { "x-acme-signature": sig, "x-acme-timestamp": ts },
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects when timestamp drifts beyond tolerance", () => {
		const verifier = buildCustomVerifier({
			scheme: "hmac-sha256",
			header: "X-Acme-Signature",
			format: "{hex}",
			secretEnv: "ACME_SECRET",
			tolerance: 60,
			timestampHeader: "X-Acme-Timestamp",
		});
		const ts = String(nowSec() - 600);
		const sig = hmacHex(`${ts}.${body}`);
		const result = verifier.verify({
			headers: { "x-acme-signature": sig, "x-acme-timestamp": ts },
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 60,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("timestamp_drift");
	});

	it("extracts eventId from a dot-path into the body (eventIdPath)", () => {
		const payload = JSON.stringify({ type: "payment.received", data: { id: "evt_abc123" } });
		const verifier = buildCustomVerifier({
			scheme: "hmac-sha256",
			header: "X-Acme-Signature",
			format: "sha256={hex}",
			secretEnv: "ACME_SECRET",
			tolerance: 300,
			eventIdPath: "data.id",
		});
		const result = verifier.verify({
			headers: { "x-acme-signature": `sha256=${hmacHex(payload)}` },
			rawBody: payload,
			parsedBody: JSON.parse(payload),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.eventId).toBe("evt_abc123");
	});

	it("extracts eventId from a header (eventIdHeader wins over path)", () => {
		const payload = JSON.stringify({ type: "ping", id: "from-body" });
		const verifier = buildCustomVerifier({
			scheme: "hmac-sha256",
			header: "X-Acme-Signature",
			format: "sha256={hex}",
			secretEnv: "ACME_SECRET",
			tolerance: 300,
			eventIdHeader: "X-Acme-Delivery",
			eventIdPath: "id",
		});
		const result = verifier.verify({
			headers: { "x-acme-signature": `sha256=${hmacHex(payload)}`, "x-acme-delivery": "hdr-evt-9" },
			rawBody: payload,
			parsedBody: JSON.parse(payload),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.eventId).toBe("hdr-evt-9");
	});

	it("falls back to empty eventId when neither eventIdHeader nor eventIdPath is configured", () => {
		const verifier = buildCustomVerifier({
			scheme: "hmac-sha256",
			header: "X-Acme-Signature",
			format: "sha256={hex}",
			secretEnv: "ACME_SECRET",
			tolerance: 300,
		});
		const result = verifier.verify({
			headers: { "x-acme-signature": `sha256=${hmacHex(body)}` },
			rawBody: body,
			parsedBody: JSON.parse(body),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.eventId).toBe("");
	});

	it("coerces a numeric body eventId to string", () => {
		const payload = JSON.stringify({ type: "ping", id: 778899 });
		const verifier = buildCustomVerifier({
			scheme: "hmac-sha256",
			header: "X-Acme-Signature",
			format: "sha256={hex}",
			secretEnv: "ACME_SECRET",
			tolerance: 300,
			eventIdPath: "id",
		});
		const result = verifier.verify({
			headers: { "x-acme-signature": `sha256=${hmacHex(payload)}` },
			rawBody: payload,
			parsedBody: JSON.parse(payload),
			secret: SECRET,
			toleranceSec: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.eventId).toBe("778899");
	});
});
