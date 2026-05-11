/**
 * @blokjs/trigger-webhook
 *
 * Inbound webhook trigger for Blok workflows. Mounts verified POST
 * routes on the shared Hono server alongside HTTP, WebSocket, and
 * SSE routes — same port, same middleware chain, same Studio
 * tracing. Verifies provider signatures (GitHub, Stripe, Slack,
 * Shopify, Svix/Standard Webhooks) or a custom HMAC scheme, applies
 * replay protection via the idempotency cache, and dispatches the
 * workflow.
 *
 * v0.7+ usage (just add the trigger to your workflow):
 *
 * ```json
 * {
 *   "name": "stripe-events",
 *   "trigger": {
 *     "webhook": {
 *       "provider": "stripe",
 *       "path": "/webhooks/stripe",
 *       "secretEnv": "STRIPE_WEBHOOK_SECRET",
 *       "namespace": "stripe",
 *       "idempotencyKey": "js/ctx.request.body.id"
 *     }
 *   },
 *   "steps": [
 *     { "id": "dispatch", "subworkflow": "js/ctx.request.body.type", "inputs": { "stripeEvent": "js/ctx.request.body" } }
 *   ]
 * }
 * ```
 *
 * See [additional-triggers-plan.mdx](../../../docs/c/devtools/additional-triggers-plan.mdx#webhook-trigger)
 * for the full design.
 */

import WebhookTrigger, { _getActiveWebhookTrigger, _setActiveWebhookTrigger } from "./WebhookTrigger";

export default WebhookTrigger;
export { WebhookTrigger, _getActiveWebhookTrigger, _setActiveWebhookTrigger };
export type { WebhookTriggerConfig } from "./WebhookTrigger";
export type { WebhookTriggerOpts } from "@blokjs/helper";
export {
	BUILTIN_VERIFIERS,
	buildCustomVerifier,
	githubVerifier,
	shopifyVerifier,
	slackVerifier,
	stripeVerifier,
	svixVerifier,
} from "./verifiers";
export type { CustomSignatureConfig, VerifyError, VerifyInput, VerifyOk, VerifyResult, Verifier } from "./verifiers";
