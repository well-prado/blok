import { workflow } from "@blokjs/helper";

/**
 * Example Queue workflow — fires when a message is received from the queue.
 *
 * Message payload + metadata on ctx.request:
 *   - ctx.request.body                  — the message payload
 *   - ctx.request.headers               — message headers / attributes
 *   - ctx.request.params.topic          — topic / queue name
 *   - ctx.request.params.partition      — Kafka partition (when applicable)
 *   - ctx.request.params.offset         — Kafka offset (when applicable)
 *   - ctx.request.params.messageId      — unique message ID
 *   - ctx.vars._queue_message           — full broker metadata
 *
 * Pick a provider in the trigger config:
 *   provider: "kafka" | "rabbitmq" | "sqs" | "redis" | "beanstalk" | "nats"
 *
 * v2 reliability knobs available on each step (uncomment to use):
 *   idempotencyKey: "$.req.params.messageId" — at-most-once delivery semantics
 *   retry: { maxAttempts: 3 }                 — retry on transient failures
 */
export default workflow({
	name: "On Queue Message",
	version: "1.0.0",
	description: "Handles incoming queue messages",
	trigger: {
		queue: {
			provider: "kafka",
			topic: "my-topic",
			consumerGroup: "my-consumer-group",
		},
	},
	steps: [
		{
			id: "process-message",
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
