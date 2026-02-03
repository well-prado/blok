import { type Step, Workflow } from "@blokjs/helper";

/**
 * Example Pub/Sub workflow - triggered when a message is received
 *
 * The message data is available in ctx.request:
 * - ctx.request.body: The message payload
 * - ctx.request.headers: Message attributes
 * - ctx.request.params.topic: The topic name
 * - ctx.request.params.subscription: The subscription name
 * - ctx.request.params.messageId: Unique message ID
 *
 * Additional metadata is available in ctx.vars._pubsub_message:
 * - topic: Topic name
 * - subscription: Subscription name
 * - publishTime: When the message was published (ISO string)
 * - attributes: JSON string of message attributes
 */
const step: Step = Workflow({
	name: "On Pub/Sub Message",
	version: "1.0.0",
	description: "Handles incoming Pub/Sub messages",
})
	.addTrigger("pubsub", {
		provider: "gcp",
		topic: "my-topic",
		subscription: "my-subscription",
	})
	.addStep({
		name: "log-message",
		node: "@blokjs/api-call",
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
	});

export default step;
