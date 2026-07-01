import { type Handle, node, step, tpl, workflow } from "@blokjs/core";

/**
 * Example Pub/Sub CONSUMER — fires when a message arrives on the topic.
 *
 * The `msg` entry handle is the message payload + metadata:
 *   - msg.body                 — the message payload
 *   - msg.params.topic         — topic / subject name
 *   - msg.params.messageId     — unique message ID
 *
 * Defaults to the local NATS broker (`provider: "nats"`) so the trigger is
 * verifiable end-to-end with zero cloud setup: start NATS, run `blokctl dev`,
 * then publish (the paired `publish-order` HTTP producer, or `nats pub
 * orders.placed '{...}'`) and watch this workflow log the message. Switch
 * `provider` to "gcp" | "aws" | "azure" for a managed broker.
 *
 * v2 reliability knobs available as step()'s 4th arg (uncomment to use):
 *   { idempotencyKey: msg.params.messageId }  — at-most-once delivery semantics
 *   { retry: { maxAttempts: 3 } }              — retry on transient failures
 */
export default workflow(
	"On Pub/Sub Message",
	{
		version: "1.0.0",
		trigger: { pubsub: { provider: "nats", topic: "orders.placed" } },
	},
	(msg) => {
		const m = msg as Handle<{ body: unknown; params: { topic: string; messageId: string } }>;
		// @blokjs/log surfaces the run directly in `blokctl dev` output — no
		// network — so a live `curl produce → broker → consumer` is observable.
		step(
			"log-message",
			node("@blokjs/log"),
			{
				level: "info",
				message: tpl`pubsub consumed a message on ${m.params.topic}`,
				attrs: { messageId: m.params.messageId, body: m.body },
			},
			{ ephemeral: true },
		);
	},
);
