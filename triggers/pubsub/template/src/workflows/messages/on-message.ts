import { workflow } from "@blokjs/helper";

/**
 * Example Pub/Sub workflow — fires when a message arrives on a subscription.
 *
 * Message payload + metadata on ctx.request:
 *   - ctx.request.body                  — the message payload
 *   - ctx.request.headers               — message attributes
 *   - ctx.request.params.topic          — topic name
 *   - ctx.request.params.subscription   — subscription name
 *   - ctx.request.params.messageId      — unique message ID
 *   - ctx.vars._pubsub_message          — full broker metadata
 *
 * Pick a provider in the trigger config:
 *   provider: "gcp" | "aws" | "azure"
 *
 * v2 reliability knobs available on each step (uncomment to use):
 *   idempotencyKey: "$.req.params.messageId" — at-most-once delivery semantics
 *   retry: { maxAttempts: 3 }                 — retry on transient failures
 */
export default workflow({
	name: "On Pub/Sub Message",
	version: "1.0.0",
	description: "Handles incoming Pub/Sub messages",
	trigger: {
		pubsub: {
			provider: "gcp",
			topic: "my-topic",
			subscription: "my-subscription",
		},
	},
	steps: [
		{
			id: "log-message",
			use: "@blokjs/api-call",
			type: "module",
			inputs: {
				url: "https://httpbin.org/post",
				method: "POST",
				body: {
					message: "js/ctx.request.body",
					topic: "js/ctx.request.params.topic",
					messageId: "js/ctx.request.params.messageId",
				},
			},
		},
	],
});
