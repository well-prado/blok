import { type Step, Workflow } from "@blokjs/helper";

/**
 * Example Queue workflow - triggered when a message is received from the queue
 *
 * The message data is available in ctx.request:
 * - ctx.request.body: The message payload
 * - ctx.request.headers: Message headers/attributes
 * - ctx.request.params.topic: The topic/queue name
 * - ctx.request.params.partition: Kafka partition (if applicable)
 * - ctx.request.params.offset: Kafka offset (if applicable)
 * - ctx.request.params.messageId: Unique message ID
 *
 * Additional metadata is available in ctx.vars._queue_message:
 * - topic: Topic/queue name
 * - partition: Partition number (Kafka)
 * - offset: Message offset (Kafka)
 * - timestamp: When the message was published (ISO string)
 * - headers: JSON string of message headers
 */
const step: Step = Workflow({
	name: "On Queue Message",
	version: "1.0.0",
	description: "Handles incoming queue messages",
})
	.addTrigger("queue", {
		provider: "kafka",
		topic: "my-topic",
		consumerGroup: "my-consumer-group",
	})
	.addStep({
		name: "process-message",
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
