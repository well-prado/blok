/**
 * RabbitMQAdapter - RabbitMQ queue adapter for QueueTrigger
 *
 * Uses amqplib for RabbitMQ connectivity.
 * Requires: npm install amqplib
 *
 * Environment variables:
 * - RABBITMQ_URL: RabbitMQ connection URL (default: amqp://localhost)
 * - RABBITMQ_PREFETCH: Number of messages to prefetch (default: 1)
 */

import type { QueueTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { QueueAdapter, QueueMessage } from "../QueueTrigger";

/**
 * RabbitMQ connection configuration
 */
export interface RabbitMQConfig {
	url: string;
	prefetch?: number;
}

/**
 * RabbitMQAdapter - RabbitMQ implementation of QueueAdapter
 */
export class RabbitMQAdapter implements QueueAdapter {
	readonly provider = "rabbitmq" as const;

	private connection: any;
	private channel: any;
	private connected = false;
	private config: RabbitMQConfig;
	private consumerTags: Map<string, string> = new Map();

	constructor(config?: Partial<RabbitMQConfig>) {
		this.config = {
			url: config?.url || process.env.RABBITMQ_URL || "amqp://localhost",
			prefetch: config?.prefetch ?? Number.parseInt(process.env.RABBITMQ_PREFETCH || "1", 10),
		};
	}

	/**
	 * Connect to RabbitMQ
	 */
	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			// Dynamic import of amqplib
			const amqplib = await import("amqplib");

			this.connection = await amqplib.connect(this.config.url);
			this.channel = await this.connection.createChannel();

			// Set prefetch count for fair dispatch
			if (this.config.prefetch) {
				await this.channel.prefetch(this.config.prefetch);
			}

			// Handle connection events
			this.connection.on("error", (err: Error) => {
				console.error(`[RabbitMQAdapter] Connection error: ${err.message}`);
				this.connected = false;
			});

			this.connection.on("close", () => {
				console.log("[RabbitMQAdapter] Connection closed");
				this.connected = false;
			});

			this.connected = true;
			console.log(`[RabbitMQAdapter] Connected to RabbitMQ: ${this.config.url}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to RabbitMQ: ${(error as Error).message}. ` +
					`Make sure amqplib is installed: npm install amqplib`,
			);
		}
	}

	/**
	 * Disconnect from RabbitMQ
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		try {
			// Cancel all consumers
			for (const [queue, tag] of this.consumerTags) {
				try {
					await this.channel.cancel(tag);
				} catch (err) {
					console.warn(`[RabbitMQAdapter] Error canceling consumer for ${queue}`);
				}
			}

			this.consumerTags.clear();

			await this.channel.close();
			await this.connection.close();
			this.connected = false;
			console.log("[RabbitMQAdapter] Disconnected from RabbitMQ");
		} catch (error) {
			console.error(`[RabbitMQAdapter] Error disconnecting: ${(error as Error).message}`);
		}
	}

	/**
	 * Subscribe to a RabbitMQ queue
	 */
	async subscribe(config: QueueTriggerOpts, handler: (message: QueueMessage) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected to RabbitMQ. Call connect() first.");
		}

		const queue = config.topic; // In RabbitMQ context, topic is the queue name

		// Assert queue exists (creates if not)
		await this.channel.assertQueue(queue, {
			durable: true,
		});

		// Start consuming
		const { consumerTag } = await this.channel.consume(
			queue,
			async (msg: any) => {
				if (!msg) return;

				// Parse message content
				let body: unknown;
				try {
					body = JSON.parse(msg.content.toString());
				} catch {
					body = msg.content.toString();
				}

				// Parse headers
				const headers: Record<string, string> = {};
				if (msg.properties.headers) {
					for (const [key, value] of Object.entries(msg.properties.headers)) {
						headers[key] = String(value);
					}
				}

				// Create queue message
				const queueMessage: QueueMessage = {
					id: msg.properties.messageId || headers["x-message-id"] || uuid(),
					body,
					headers,
					raw: msg,
					topic: queue,
					timestamp: msg.properties.timestamp ? new Date(msg.properties.timestamp) : new Date(),
					ack: async () => {
						this.channel.ack(msg);
					},
					nack: async (requeue = true) => {
						this.channel.nack(msg, false, requeue);
					},
				};

				// Process message
				try {
					await handler(queueMessage);
				} catch (error) {
					console.error(`[RabbitMQAdapter] Error processing message: ${(error as Error).message}`);
					// Let the handler decide whether to ack/nack
				}
			},
			{
				noAck: config.ack === false, // If ack is false, use noAck mode
			},
		);

		this.consumerTags.set(queue, consumerTag);
		console.log(`[RabbitMQAdapter] Subscribed to queue: ${queue}`);
	}

	/**
	 * Unsubscribe from a RabbitMQ queue
	 */
	async unsubscribe(topic: string): Promise<void> {
		const consumerTag = this.consumerTags.get(topic);
		if (consumerTag) {
			await this.channel.cancel(consumerTag);
			this.consumerTags.delete(topic);
			console.log(`[RabbitMQAdapter] Unsubscribed from queue: ${topic}`);
		}
	}

	/**
	 * Check if connected to RabbitMQ
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Health check - verify RabbitMQ connectivity
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;

		try {
			// Try to check channel status
			await this.channel.checkQueue("amq.rabbitmq.reply-to");
			return true;
		} catch {
			// Queue might not exist but channel is healthy
			return this.connected;
		}
	}
}

export default RabbitMQAdapter;
