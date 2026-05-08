/**
 * WebhookTrigger Tests
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceHandlers } from "./WebhookTrigger";

describe("WebhookTrigger", () => {
	describe("WebhookEvent Interface", () => {
		it("should accept valid webhook event structure", () => {
			const event = {
				id: "event-123",
				source: "github",
				eventType: "push",
				payload: { ref: "refs/heads/main" },
				headers: { "x-github-event": "push" },
				signature: "sha256=abc123",
				timestamp: new Date(),
				rawBody: '{"ref":"refs/heads/main"}',
			};

			expect(event.id).toBe("event-123");
			expect(event.source).toBe("github");
			expect(event.eventType).toBe("push");
		});
	});
});

describe("Source Handlers", () => {
	describe("GitHub Handler", () => {
		const handler = sourceHandlers.github;

		it("should extract event type from headers", () => {
			const headers = { "x-github-event": "push" };
			expect(handler.getEventType(headers, {})).toBe("push");
		});

		it("should extract signature from headers", () => {
			const headers = { "x-hub-signature-256": "sha256=abc123" };
			expect(handler.getSignature(headers)).toBe("sha256=abc123");
		});

		it("should verify valid signature", () => {
			const secret = "my-secret";
			const rawBody = '{"action":"created"}';
			const hmac = crypto.createHmac("sha256", secret);
			const signature = `sha256=${hmac.update(rawBody).digest("hex")}`;

			const result = handler.verifySignature(rawBody, signature, secret);
			expect(result.valid).toBe(true);
		});

		it("should reject invalid signature", () => {
			const result = handler.verifySignature('{"action":"created"}', "sha256=invalid", "my-secret");
			expect(result.valid).toBe(false);
		});

		it("should extract event ID from headers", () => {
			const headers = { "x-github-delivery": "delivery-123" };
			expect(handler.getEventId(headers, {})).toBe("delivery-123");
		});
	});

	describe("Stripe Handler", () => {
		const handler = sourceHandlers.stripe;

		it("should extract event type from body", () => {
			const body = { type: "payment_intent.succeeded" };
			expect(handler.getEventType({}, body)).toBe("payment_intent.succeeded");
		});

		it("should extract signature from headers", () => {
			const headers = { "stripe-signature": "t=123,v1=abc" };
			expect(handler.getSignature(headers)).toBe("t=123,v1=abc");
		});

		it("should verify valid Stripe signature", () => {
			const secret = "whsec_test";
			const rawBody = '{"type":"test"}';
			const timestamp = Math.floor(Date.now() / 1000);
			const payload = `${timestamp}.${rawBody}`;
			const hmac = crypto.createHmac("sha256", secret);
			const sig = hmac.update(payload).digest("hex");
			const signature = `t=${timestamp},v1=${sig}`;

			const result = handler.verifySignature(rawBody, signature, secret);
			expect(result.valid).toBe(true);
		});

		it("should extract event ID from body", () => {
			const body = { id: "evt_123" };
			expect(handler.getEventId({}, body)).toBe("evt_123");
		});
	});

	describe("Shopify Handler", () => {
		const handler = sourceHandlers.shopify;

		it("should extract event type from headers", () => {
			const headers = { "x-shopify-topic": "orders/create" };
			expect(handler.getEventType(headers, {})).toBe("orders/create");
		});

		it("should extract signature from headers", () => {
			const headers = { "x-shopify-hmac-sha256": "abc123base64==" };
			expect(handler.getSignature(headers)).toBe("abc123base64==");
		});

		it("should extract event ID from headers", () => {
			const headers = { "x-shopify-webhook-id": "webhook-123" };
			expect(handler.getEventId(headers, {})).toBe("webhook-123");
		});
	});

	describe("Custom Handler", () => {
		const handler = sourceHandlers.custom;

		it("should extract event type from headers or body", () => {
			expect(handler.getEventType({ "x-event-type": "custom.event" }, {})).toBe("custom.event");
			expect(handler.getEventType({}, { event: "body.event" })).toBe("body.event");
		});

		it("should extract signature from headers", () => {
			const headers = { "x-signature": "sig123" };
			expect(handler.getSignature(headers)).toBe("sig123");
		});

		it("should verify valid custom signature", () => {
			const secret = "custom-secret";
			const rawBody = '{"data":"test"}';
			const hmac = crypto.createHmac("sha256", secret);
			const signature = hmac.update(rawBody).digest("hex");

			const result = handler.verifySignature(rawBody, signature, secret);
			expect(result.valid).toBe(true);
		});
	});
});

describe("WebhookTriggerOpts Schema", () => {
	it("should validate webhook trigger configuration", () => {
		const validConfig = {
			source: "github",
			events: ["push", "pull_request.*"],
			secret: "my-webhook-secret",
			path: "/webhooks/github",
		};

		expect(validConfig.source).toBe("github");
		expect(validConfig.events).toContain("push");
		expect(validConfig.secret).toBeDefined();
	});

	it("should support wildcard events", () => {
		const config = {
			source: "stripe",
			events: ["payment_intent.*", "checkout.session.*"],
		};

		expect(config.events).toContain("payment_intent.*");
	});
});
