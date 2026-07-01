import { node, step, workflow } from "@blokjs/core";

/**
 * Example Pub/Sub workflow — fires when a message arrives on a subscription.
 *
 * The `msg` entry handle is the message payload + metadata:
 *   - msg.body                 — the message payload
 *   - msg.headers              — message attributes
 *   - msg.params.topic         — topic name
 *   - msg.params.subscription  — subscription name
 *   - msg.params.messageId     — unique message ID
 *
 * Pick a provider in the trigger config: provider: "gcp" | "aws" | "azure".
 *
 * v2 reliability knobs available as step()'s 4th arg (uncomment to use):
 *   { idempotencyKey: msg.params.messageId }  — at-most-once delivery semantics
 *   { retry: { maxAttempts: 3 } }              — retry on transient failures
 */
export default workflow(
	"On Pub/Sub Message",
	{
		version: "1.0.0",
		trigger: { pubsub: { provider: "gcp", topic: "my-topic", subscription: "my-subscription" } },
	},
	(msg) => {
		step("log-message", node("@blokjs/api-call"), {
			url: "https://httpbin.org/post",
			method: "POST",
			body: {
				message: msg.body,
				topic: msg.params.topic,
				messageId: msg.params.messageId,
			},
		});
	},
);
