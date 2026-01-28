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
 * - SQS_WAIT_TIME_SECONDS: Long polling wait time (default: 20)
 * - SQS_MAX_MESSAGES: Max messages per receive (default: 10)
 */

import type { PubSubAdapter, PubSubMessage } from "../PubSubTrigger";
import type { PubSubTriggerOpts } from "@nanoservice-ts/helper";
import { v4 as uuid } from "uuid";

/**
 * AWS SNS/SQS configuration
 */
export interface AWSSNSConfig {
	region: string;
	waitTimeSeconds?: number;
	maxNumberOfMessages?: number;
}

/**
 * AWSSNSAdapter - AWS SNS implementation using SQS subscriptions
 */
export class AWSSNSAdapter implements PubSubAdapter {
	readonly provider = "aws" as const;

	private sqsClient: any;
	private connected = false;
	private config: AWSSNSConfig;
	private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
	private shouldStop = false;

	constructor(config?: Partial<AWSSNSConfig>) {
		this.config = {
			region: config?.region || process.env.AWS_REGION || "us-east-1",
			waitTimeSeconds: config?.waitTimeSeconds ?? parseInt(process.env.SQS_WAIT_TIME_SECONDS || "20", 10),
			maxNumberOfMessages: config?.maxNumberOfMessages ?? parseInt(process.env.SQS_MAX_MESSAGES || "10", 10),
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
			});

			this.connected = true;
			this.shouldStop = false;
			console.log(`[AWSSNSAdapter] Connected to AWS SNS/SQS: ${this.config.region}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to AWS: ${(error as Error).message}. ` +
					`Make sure @aws-sdk/client-sqs is installed: npm install @aws-sdk/client-sqs`,
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
	async subscribe(
		config: PubSubTriggerOpts,
		handler: (message: PubSubMessage) => Promise<void>,
	): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected to AWS. Call connect() first.");
		}

		// In AWS, subscription is the SQS queue URL that's subscribed to the SNS topic
		const queueUrl = config.subscription;

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
				MessageAttributeNames: ["All"],
				AttributeNames: ["All"],
			});

			const response = await this.sqsClient.send(command);

			if (response.Messages && response.Messages.length > 0) {
				for (const msg of response.Messages) {
					// Parse SNS message wrapper
					let snsMessage: any;
					let body: unknown;

					try {
						snsMessage = JSON.parse(msg.Body || "{}");
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
							attributes[key] = (attr as any).StringValue || "";
						}
					}

					// SNS message attributes (if present)
					if (snsMessage.MessageAttributes) {
						for (const [key, attr] of Object.entries(snsMessage.MessageAttributes)) {
							attributes[`sns_${key}`] = (attr as any).Value || "";
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
							await this.sqsClient.send(deleteCommand);
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
							await this.sqsClient.send(changeCommand);
						},
					};

					// Process message
					try {
						await handler(pubsubMessage);
					} catch (error) {
						console.error(
							`[AWSSNSAdapter] Error processing message: ${(error as Error).message}`,
						);
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
	 * Health check - verify AWS connectivity
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;

		try {
			const { ListQueuesCommand } = await import("@aws-sdk/client-sqs");
			const command = new ListQueuesCommand({ MaxResults: 1 });
			await this.sqsClient.send(command);
			return true;
		} catch {
			return false;
		}
	}
}

export default AWSSNSAdapter;
