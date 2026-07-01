/**
 * AWSSNSAdapter - AWS SNS/SQS adapter for PubSubTrigger
 *
 * Uses AWS SDK v3 for SNS/SQS connectivity.
 * SNS topics deliver to SQS queues, which this adapter polls.
 *
 * Requires: npm install @aws-sdk/client-sns @aws-sdk/client-sqs
 *
 * Environment variables:
 * - AWS_REGION: AWS region (default: us-east-1)
 * - AWS_ACCESS_KEY_ID: AWS access key (optional if using IAM roles)
 * - AWS_SECRET_ACCESS_KEY: AWS secret key (optional if using IAM roles)
 * - AWS_ENDPOINT_URL: override endpoint for both SNS + SQS (LocalStack / ElasticMQ)
 * - SQS_WAIT_TIME_SECONDS: Long polling wait time (default: 20)
 * - SQS_MAX_MESSAGES: Max messages per receive (default: 10)
 */

import type { MessageAttributeValue, SQSClient } from "@aws-sdk/client-sqs";
import type { PubSubTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { PubSubAdapter, PubSubMessage } from "../PubSubTrigger";

/**
 * Shape of an SNS notification when delivered to an SQS subscription.
 * SNS-to-SQS subscriptions wrap the publisher's payload inside a JSON
 * envelope; the receiver parses `msg.Body` as this envelope and reads
 * `Message` (the actual payload) plus the SNS-side attributes.
 */
interface SNSNotificationEnvelope {
	Type?: string;
	MessageId?: string;
	TopicArn?: string;
	Message?: string;
	Subject?: string;
	Timestamp?: string;
	MessageAttributes?: Record<string, { Type?: string; Value?: string }>;
}

/**
 * AWS SNS/SQS configuration
 */
export interface AWSSNSConfig {
	region: string;
	/** Override endpoint for both SNS + SQS (LocalStack / ElasticMQ). */
	endpoint?: string;
	waitTimeSeconds?: number;
	maxNumberOfMessages?: number;
}

/**
 * AWSSNSAdapter - AWS SNS implementation using SQS subscriptions
 */
export class AWSSNSAdapter implements PubSubAdapter {
	readonly provider = "aws" as const;

	private sqsClient: SQSClient | undefined;
	private connected = false;
	private config: AWSSNSConfig;
	private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
	private shouldStop = false;

	/**
	 * Type-narrowing accessor for `this.sqsClient`. Field is undefined
	 * until `connect()` runs.
	 */
	private requireSqsClient(): SQSClient {
		if (!this.sqsClient) {
			throw new Error("[AWSSNSAdapter] SQS client is not initialised — call connect() first");
		}
		return this.sqsClient;
	}

	constructor(config?: Partial<AWSSNSConfig>) {
		this.config = {
			region: config?.region || process.env.AWS_REGION || "us-east-1",
			endpoint: config?.endpoint ?? process.env.AWS_ENDPOINT_URL,
			waitTimeSeconds: config?.waitTimeSeconds ?? Number.parseInt(process.env.SQS_WAIT_TIME_SECONDS || "20", 10),
			maxNumberOfMessages: config?.maxNumberOfMessages ?? Number.parseInt(process.env.SQS_MAX_MESSAGES || "10", 10),
		};
	}

	/**
	 * Connect to AWS
	 */
	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			// Dynamic import of AWS SDK
			const { SQSClient } = await import("@aws-sdk/client-sqs");

			this.sqsClient = new SQSClient({
				region: this.config.region,
				endpoint: this.config.endpoint,
			});

			this.connected = true;
			this.shouldStop = false;
			console.log(`[AWSSNSAdapter] Connected to AWS SNS/SQS: ${this.config.region}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to AWS: ${(error as Error).message}. Make sure @aws-sdk/client-sqs is installed: npm install @aws-sdk/client-sqs`,
			);
		}
	}

	/**
	 * Disconnect from AWS
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		this.shouldStop = true;

		// Clear all polling intervals
		for (const [queueUrl, interval] of this.pollingIntervals) {
			clearTimeout(interval);
		}
		this.pollingIntervals.clear();

		this.connected = false;
		console.log("[AWSSNSAdapter] Disconnected from AWS SNS/SQS");
	}

	/**
	 * Subscribe to an SNS topic via SQS queue
	 * Note: The SQS queue should be pre-configured as an SNS subscription
	 */
	async subscribe(config: PubSubTriggerOpts, handler: (message: PubSubMessage) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected to AWS. Call connect() first.");
		}

		// In AWS, subscription is the SQS queue URL that's subscribed to the SNS topic.
		if (!config.subscription) {
			throw new Error("[AWSSNSAdapter] `subscription` is required — must be the SQS queue URL bound to the SNS topic.");
		}
		const queueUrl = config.subscription;

		// SQS has no replay: a message is gone once deleted, and a queue only
		// holds what was delivered after the SNS subscription existed. There is
		// no earliest/latest/seq/timestamp cursor to honor, so `startFrom` would
		// be a silent lie. Reject at startup rather than pretend.
		if (config.startFrom !== undefined) {
			throw new Error(
				"[AWSSNSAdapter] `startFrom` is not supported for provider 'aws' — SQS cannot replay retained history. Remove `startFrom` (or use a broker with a durable log such as Kafka / Redis Streams / NATS JetStream).",
			);
		}

		// SNS->SQS topology is fan-out at the SNS layer (each subscribed queue
		// gets its own copy) and competing-consumer WITHIN a single queue (many
		// pollers share one queue). There is no Kafka-style group rebalancing to
		// join, so `consumerGroup` has no effect here. Warn so authors don't
		// expect partition assignment / group semantics.
		if (config.consumerGroup) {
			console.warn(
				`[AWSSNSAdapter] \`consumerGroup\` ("${config.consumerGroup}") has no effect for provider 'aws'. SNS->SQS fan-out is per-subscribed-queue; competing consumers share one SQS queue URL. There is no Kafka-style group rebalancing.`,
			);
		}

		// Start polling the SQS queue
		this.poll(queueUrl, config, handler);

		console.log(`[AWSSNSAdapter] Subscribed to queue: ${queueUrl} (topic: ${config.topic})`);
	}

	/**
	 * Poll SQS queue for messages (long polling)
	 */
	private async poll(
		queueUrl: string,
		config: PubSubTriggerOpts,
		handler: (message: PubSubMessage) => Promise<void>,
	): Promise<void> {
		if (this.shouldStop) return;

		try {
			const { ReceiveMessageCommand, DeleteMessageCommand } = await import("@aws-sdk/client-sqs");

			const command = new ReceiveMessageCommand({
				QueueUrl: queueUrl,
				MaxNumberOfMessages: config.maxMessages || this.config.maxNumberOfMessages,
				WaitTimeSeconds: this.config.waitTimeSeconds,
				// `ackDeadline` (seconds) → SQS per-receive VisibilityTimeout: how
				// long a received message is hidden before it reappears if not
				// deleted. Omitted → SQS falls back to the queue-level default.
				...(typeof config.ackDeadline === "number" ? { VisibilityTimeout: config.ackDeadline } : {}),
				MessageAttributeNames: ["All"],
				AttributeNames: ["All"],
			});

			const response = await this.requireSqsClient().send(command);

			if (response.Messages && response.Messages.length > 0) {
				for (const msg of response.Messages) {
					// Parse SNS message wrapper
					let snsMessage: SNSNotificationEnvelope;
					let body: unknown;

					try {
						snsMessage = JSON.parse(msg.Body || "{}") as SNSNotificationEnvelope;
						// SNS wraps the actual message in a "Message" field
						if (snsMessage.Type === "Notification" && snsMessage.Message) {
							try {
								body = JSON.parse(snsMessage.Message);
							} catch {
								body = snsMessage.Message;
							}
						} else {
							body = snsMessage;
						}
					} catch {
						body = msg.Body;
						snsMessage = {};
					}

					// Extract attributes from both SQS and SNS
					const attributes: Record<string, string> = {};

					// SQS message attributes
					if (msg.MessageAttributes) {
						for (const [key, attr] of Object.entries(msg.MessageAttributes)) {
							const sqsAttr = attr as MessageAttributeValue;
							attributes[key] = sqsAttr.StringValue || "";
						}
					}

					// SNS message attributes (if present)
					if (snsMessage.MessageAttributes) {
						for (const [key, attr] of Object.entries(snsMessage.MessageAttributes)) {
							attributes[`sns_${key}`] = attr.Value || "";
						}
					}

					// Create pub/sub message
					const pubsubMessage: PubSubMessage = {
						id: snsMessage.MessageId || msg.MessageId || uuid(),
						body,
						attributes,
						raw: msg,
						topic: snsMessage.TopicArn || config.topic,
						subscription: queueUrl,
						publishTime: snsMessage.Timestamp ? new Date(snsMessage.Timestamp) : new Date(),
						ack: async () => {
							const deleteCommand = new DeleteMessageCommand({
								QueueUrl: queueUrl,
								ReceiptHandle: msg.ReceiptHandle,
							});
							await this.requireSqsClient().send(deleteCommand);
						},
						nack: async () => {
							// Let the visibility timeout expire to return the message
							// Or change visibility to 0 for immediate retry
							const { ChangeMessageVisibilityCommand } = await import("@aws-sdk/client-sqs");
							const changeCommand = new ChangeMessageVisibilityCommand({
								QueueUrl: queueUrl,
								ReceiptHandle: msg.ReceiptHandle,
								VisibilityTimeout: 0,
							});
							await this.requireSqsClient().send(changeCommand);
						},
					};

					// Process message
					try {
						await handler(pubsubMessage);
					} catch (error) {
						console.error(`[AWSSNSAdapter] Error processing message: ${(error as Error).message}`);
					}
				}
			}
		} catch (error) {
			console.error(`[AWSSNSAdapter] Polling error: ${(error as Error).message}`);
		}

		// Continue polling unless stopped
		if (!this.shouldStop) {
			const timeout = setTimeout(() => this.poll(queueUrl, config, handler), 0);
			this.pollingIntervals.set(queueUrl, timeout);
		}
	}

	/**
	 * Unsubscribe from a queue (stops polling)
	 */
	async unsubscribe(queueUrl: string): Promise<void> {
		const interval = this.pollingIntervals.get(queueUrl);
		if (interval) {
			clearTimeout(interval);
			this.pollingIntervals.delete(queueUrl);
			console.log(`[AWSSNSAdapter] Unsubscribed from queue: ${queueUrl}`);
		}
	}

	/**
	 * Check if connected to AWS
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * v0.7 PR 6 — publish to an SNS topic.
	 *
	 * `topic` must be the SNS topic ARN. `partitionKey` /
	 * `orderingKey` map to the FIFO `MessageGroupId` field for
	 * `.fifo` topics; ignored otherwise.
	 */
	async publish(
		topic: string,
		payload: unknown,
		opts?: { partitionKey?: string; orderingKey?: string },
	): Promise<void> {
		if (!this.connected) throw new Error("[blok][pubsub-aws] not connected. Call connect() first.");
		const moduleName = "@aws-sdk/client-sns";
		// biome-ignore lint/suspicious/noExplicitAny: SDK loaded at runtime as a peer dep.
		const sns: any = await import(moduleName);
		const client = new sns.SNSClient({ region: this.config.region, endpoint: this.config.endpoint });
		const isFifo = topic.endsWith(".fifo");
		const params: Record<string, unknown> = {
			TopicArn: topic,
			Message: typeof payload === "string" ? payload : JSON.stringify(payload),
		};
		if (isFifo) {
			params.MessageGroupId = opts?.partitionKey ?? opts?.orderingKey ?? "default";
			params.MessageDeduplicationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		}
		try {
			await client.send(new sns.PublishCommand(params));
		} finally {
			client.destroy?.();
		}
	}

	/**
	 * Health check - verify AWS connectivity
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;

		try {
			const { ListQueuesCommand } = await import("@aws-sdk/client-sqs");
			const command = new ListQueuesCommand({ MaxResults: 1 });
			await this.requireSqsClient().send(command);
			return true;
		} catch {
			return false;
		}
	}
}

export default AWSSNSAdapter;
