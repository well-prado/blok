/**
 * @blok/trigger-webhook
 *
 * Webhook trigger for Blok workflows.
 * Handle webhook events from external services.
 *
 * Supported Services:
 * - GitHub (push, pull_request, issues, releases, etc.)
 * - Stripe (payment_intent, checkout.session, customer, etc.)
 * - Shopify (orders, products, customers, etc.)
 * - Custom webhooks (any service with signature verification)
 *
 * Features:
 * - Signature verification (HMAC-SHA256)
 * - Event type filtering
 * - Source-specific handlers
 * - Custom source registration
 *
 * @example
 * ```typescript
 * import { WebhookTrigger } from "@blok/trigger-webhook";
 *
 * class MyWebhookTrigger extends WebhookTrigger {
 *   protected nodes = myNodes;
 *   protected workflows = myWorkflows;
 * }
 *
 * const trigger = new MyWebhookTrigger();
 * await trigger.listen();
 *
 * // In your HTTP endpoint handler:
 * app.post("/webhooks/:source", async (req, res) => {
 *   const rawBody = JSON.stringify(req.body);
 *   const result = await trigger.handleWebhook(
 *     req.params.source,
 *     rawBody,
 *     req.headers as Record<string, string>
 *   );
 *   res.status(200).json({ received: true });
 * });
 * ```
 *
 * Workflow Definition:
 * ```typescript
 * Workflow({ name: "github-push", version: "1.0.0" })
 *   .addTrigger("webhook", {
 *     source: "github",
 *     events: ["push", "pull_request.*"],
 *     secret: process.env.GITHUB_WEBHOOK_SECRET,
 *   })
 *   .addStep({ ... });
 * ```
 *
 * Custom Source Handler:
 * ```typescript
 * import { WebhookTrigger } from "@blok/trigger-webhook";
 *
 * WebhookTrigger.registerSourceHandler("my-service", {
 *   getEventType: (headers, body) => body.event_type,
 *   getSignature: (headers) => headers["x-my-signature"],
 *   verifySignature: (rawBody, signature, secret) => {
 *     // Your verification logic
 *     return { valid: true };
 *   },
 *   getEventId: (headers, body) => body.id,
 * });
 * ```
 */

// Core exports
export {
	WebhookTrigger,
	sourceHandlers,
	type WebhookEvent,
	type VerificationResult,
	type WebhookSourceHandler,
} from "./WebhookTrigger";

// Re-export types from helper for convenience
export type { WebhookTriggerOpts } from "@blok/helper";
