/**
 * SQSAdapter - AWS SQS queue adapter for QueueTrigger
 *
 * Uses AWS SDK v3 for SQS connectivity.
 * Requires: npm install @aws-sdk/client-sqs
 *
 * Environment variables:
 * - AWS_REGION: AWS region (default: us-east-1)
 * - AWS_ACCESS_KEY_ID: AWS access key (optional if using IAM roles)
 * - AWS_SECRET_ACCESS_KEY: AWS secret key (optional if using IAM roles)
 * - SQS_WAIT_TIME_SECONDS: Long polling wait time (default: 20)
 * - SQS_MAX_MESSAGES: Max messages per receive (default: 10)
 * - SQS_VISIBILITY_TIMEOUT: Visibility timeout in seconds (default: 30)
 */

import type { QueueTriggerOpts } from "@blok/helper";
import { v4 as uuid } from "uuid";
import type { QueueAdapter, QueueMessage } from "../QueueTrigger";

/**
 * SQS connection configuration
 */
export interface SQSConfig {
	region: string;
	waitTimeSeconds?: number;
	maxNumberOfMessages?: number;
	visibilityTimeout?: number;
}

/**
 * SQSAdapter - AWS SQS implementation of QueueAdapter
 */
export class SQSAdapter implements QueueAdapter {
	readonly provider = "sqs" as const;

	private client: any;
	private connected = false;
	private config: SQSConfig;
	private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
	private shouldStop = false;

	constructor(config?: Partial<SQSConfig>) {
		this.config = {
			region: config?.region || process.env.AWS_REGION || "us-east-1",
			waitTimeSeconds: config?.waitTimeSeconds ?? Number.parseInt(process.env.SQS_WAIT_TIME_SECONDS || "20", 10),
			maxNumberOfMessages: config?.maxNumberOfMessages ?? Number.parseInt(process.env.SQS_MAX_MESSAGES || "10", 10),
			visibilityTimeout: config?.visibilityTimeout ?? Number.parseInt(process.env.SQS_VISIBILITY_TIMEOUT || "30", 10),
		};
	}

	/**
	 * Connect to AWS SQS
	 */
	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			// Dynamic import of AWS SDK
			const { SQSClient } = await import("@aws-sdk/client-sqs");

			this.client = new SQSClient({
				region: this.config.region,
			});

			this.connected = true;
			this.shouldStop = false;
			console.log(`[SQSAdapter] Connected to AWS SQS: ${this.config.region}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to AWS SQS: ${(error as Error).message}. ` +
					`Make sure @aws-sdk/client-sqs is installed: npm install @aws-sdk/client-sqs`,
			);
		}
	}

	/**
	 * Disconnect from AWS SQS
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
		console.log("[SQSAdapter] Disconnected from AWS SQS");
	}

	/**
	 * Subscribe to an SQS queue (starts long polling)
	 */
	async subscribe(config: QueueTriggerOpts, handler: (message: QueueMessage) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected to AWS SQS. Call connect() first.");
		}

		const queueUrl = config.topic; // In SQS context, topic is the queue URL

		// Start polling loop
		this.poll(queueUrl, config, handler);

		console.log(`[SQSAdapter] Subscribed to queue: ${queueUrl}`);
	}

	/**
	 * Poll for messages (long polling)
	 */
	private async poll(
		queueUrl: string,
		config: QueueTriggerOpts,
		handler: (message: QueueMessage) => Promise<void>,
	): Promise<void> {
		if (this.shouldStop) return;

		try {
			const { ReceiveMessageCommand, DeleteMessageCommand } = await import("@aws-sdk/client-sqs");

			const command = new ReceiveMessageCommand({
				QueueUrl: queueUrl,
				MaxNumberOfMessages: config.batchSize || this.config.maxNumberOfMessages,
				WaitTimeSeconds: this.config.waitTimeSeconds,
				VisibilityTimeout: this.config.visibilityTimeout,
				MessageAttributeNames: ["All"],
				AttributeNames: ["All"],
			});

			const response = await this.client.send(command);

			if (response.Messages && response.Messages.length > 0) {
				for (const msg of response.Messages) {
					// Parse message body
					let body: unknown;
					try {
						body = JSON.parse(msg.Body || "");
					} catch {
						body = msg.Body;
					}

					// Parse message attributes as headers
					const headers: Record<string, string> = {};
					if (msg.MessageAttributes) {
						for (const [key, attr] of Object.entries(msg.MessageAttributes)) {
							headers[key] = (attr as any).StringValue || String((attr as any).BinaryValue) || "";
						}
					}

					// Create queue message
					const queueMessage: QueueMessage = {
						id: msg.MessageId || uuid(),
						body,
						headers,
						raw: msg,
						topic: queueUrl,
						timestamp: msg.Attributes?.SentTimestamp
							? new Date(Number.parseInt(msg.Attributes.SentTimestamp))
							: new Date(),
						ack: async () => {
							const deleteCommand = new DeleteMessageCommand({
								QueueUrl: queueUrl,
								ReceiptHandle: msg.ReceiptHandle,
							});
							await this.client.send(deleteCommand);
						},
						nack: async (_requeue = true) => {
							// In SQS, messages automatically return to queue after visibility timeout
							// For immediate return, we could change visibility timeout to 0
							if (_requeue) {
								const { ChangeMessageVisibilityCommand } = await import("@aws-sdk/client-sqs");
								const changeCommand = new ChangeMessageVisibilityCommand({
									QueueUrl: queueUrl,
									ReceiptHandle: msg.ReceiptHandle,
									VisibilityTimeout: 0, // Return message to queue immediately
								});
								await this.client.send(changeCommand);
							}
						},
					};

					// Process message
					try {
						await handler(queueMessage);
					} catch (error) {
						console.error(`[SQSAdapter] Error processing message: ${(error as Error).message}`);
					}
				}
			}
		} catch (error) {
			console.error(`[SQSAdapter] Polling error: ${(error as Error).message}`);
		}

		// Continue polling unless stopped
		if (!this.shouldStop) {
			const timeout = setTimeout(() => this.poll(queueUrl, config, handler), 0);
			this.pollingIntervals.set(queueUrl, timeout);
		}
	}

	/**
	 * Unsubscribe from an SQS queue (stops polling)
	 */
	async unsubscribe(queueUrl: string): Promise<void> {
		const interval = this.pollingIntervals.get(queueUrl);
		if (interval) {
			clearTimeout(interval);
			this.pollingIntervals.delete(queueUrl);
			console.log(`[SQSAdapter] Unsubscribed from queue: ${queueUrl}`);
		}
	}

	/**
	 * Check if connected to SQS
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Health check - verify SQS connectivity
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;

		try {
			const { ListQueuesCommand } = await import("@aws-sdk/client-sqs");
			const command = new ListQueuesCommand({ MaxResults: 1 });
			await this.client.send(command);
			return true;
		} catch {
			return false;
		}
	}
}

export default SQSAdapter;
