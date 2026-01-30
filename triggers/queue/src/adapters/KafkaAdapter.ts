/**
 * KafkaAdapter - Apache Kafka queue adapter for QueueTrigger
 *
 * Uses kafkajs for Kafka connectivity.
 * Requires: npm install kafkajs
 *
 * Environment variables:
 * - KAFKA_BROKERS: Comma-separated list of Kafka brokers (default: localhost:9092)
 * - KAFKA_CLIENT_ID: Client ID for this consumer (default: blok-queue-trigger)
 * - KAFKA_GROUP_ID: Consumer group ID (default: blok-consumer-group)
 * - KAFKA_SSL: Enable SSL (default: false)
 * - KAFKA_SASL_MECHANISM: SASL mechanism (plain, scram-sha-256, scram-sha-512)
 * - KAFKA_SASL_USERNAME: SASL username
 * - KAFKA_SASL_PASSWORD: SASL password
 */

import type { QueueTriggerOpts } from "@nanoservice-ts/helper";
import { v4 as uuid } from "uuid";
import type { QueueAdapter, QueueMessage } from "../QueueTrigger";

// Dynamic import for optional dependency
let Kafka: any;
let Consumer: any;
let EachMessagePayload: any;

/**
 * Kafka connection configuration
 */
export interface KafkaConfig {
	brokers: string[];
	clientId: string;
	ssl?: boolean;
	sasl?: {
		mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
		username: string;
		password: string;
	};
}

/**
 * KafkaAdapter - Kafka implementation of QueueAdapter
 */
export class KafkaAdapter implements QueueAdapter {
	readonly provider = "kafka" as const;

	private kafka: any;
	private consumer: any;
	private connected = false;
	private config: KafkaConfig;
	private subscriptions: Map<string, (message: QueueMessage) => Promise<void>> = new Map();

	constructor(config?: Partial<KafkaConfig>) {
		this.config = {
			brokers: config?.brokers || process.env.KAFKA_BROKERS?.split(",") || ["localhost:9092"],
			clientId: config?.clientId || process.env.KAFKA_CLIENT_ID || "blok-queue-trigger",
			ssl: config?.ssl ?? process.env.KAFKA_SSL === "true",
			sasl: config?.sasl || this.getSaslConfig(),
		};
	}

	/**
	 * Get SASL configuration from environment
	 */
	private getSaslConfig() {
		const mechanism = process.env.KAFKA_SASL_MECHANISM as "plain" | "scram-sha-256" | "scram-sha-512" | undefined;
		const username = process.env.KAFKA_SASL_USERNAME;
		const password = process.env.KAFKA_SASL_PASSWORD;

		if (mechanism && username && password) {
			return { mechanism, username, password };
		}
		return undefined;
	}

	/**
	 * Connect to Kafka cluster
	 */
	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			// Dynamic import of kafkajs
			const kafkajs = await import("kafkajs");
			Kafka = kafkajs.Kafka;

			this.kafka = new Kafka({
				clientId: this.config.clientId,
				brokers: this.config.brokers,
				ssl: this.config.ssl,
				sasl: this.config.sasl,
			});

			this.consumer = this.kafka.consumer({
				groupId: process.env.KAFKA_GROUP_ID || "blok-consumer-group",
			});

			await this.consumer.connect();
			this.connected = true;

			console.log(`[KafkaAdapter] Connected to Kafka: ${this.config.brokers.join(", ")}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to Kafka: ${(error as Error).message}. ` +
					`Make sure kafkajs is installed: npm install kafkajs`,
			);
		}
	}

	/**
	 * Disconnect from Kafka cluster
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		try {
			await this.consumer.disconnect();
			this.connected = false;
			this.subscriptions.clear();
			console.log("[KafkaAdapter] Disconnected from Kafka");
		} catch (error) {
			console.error(`[KafkaAdapter] Error disconnecting: ${(error as Error).message}`);
		}
	}

	/**
	 * Subscribe to a Kafka topic
	 */
	async subscribe(config: QueueTriggerOpts, handler: (message: QueueMessage) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected to Kafka. Call connect() first.");
		}

		const topic = config.topic;

		// Subscribe to topic
		await this.consumer.subscribe({
			topic,
			fromBeginning: false,
		});

		// Store handler
		this.subscriptions.set(topic, handler);

		// Start consuming if not already running
		await this.consumer.run({
			eachMessage: async ({
				topic: msgTopic,
				partition,
				message,
			}: {
				topic: string;
				partition: number;
				message: any;
			}) => {
				const messageHandler = this.subscriptions.get(msgTopic);
				if (!messageHandler) return;

				// Parse message value
				let body: unknown;
				try {
					const value = message.value?.toString();
					body = value ? JSON.parse(value) : null;
				} catch {
					body = message.value?.toString() || null;
				}

				// Parse headers
				const headers: Record<string, string> = {};
				if (message.headers) {
					for (const [key, value] of Object.entries(message.headers)) {
						headers[key] = (value as Buffer)?.toString() || String(value);
					}
				}

				// Create queue message
				const queueMessage: QueueMessage = {
					id: headers["x-message-id"] || uuid(),
					body,
					headers,
					raw: message,
					topic: msgTopic,
					partition,
					offset: message.offset,
					timestamp: message.timestamp ? new Date(Number.parseInt(message.timestamp)) : new Date(),
					ack: async () => {
						// Kafka uses auto-commit by default
						// For manual commit, would call: await this.consumer.commitOffsets([...])
					},
					nack: async (_requeue?: boolean) => {
						// Kafka doesn't have native nack - handled by consumer group rebalance
						// Could implement retry topic pattern here
						console.warn(
							`[KafkaAdapter] Message nack not fully supported in Kafka. ` + `Consider implementing dead letter topic.`,
						);
					},
				};

				// Process message
				await messageHandler(queueMessage);
			},
		});

		console.log(`[KafkaAdapter] Subscribed to topic: ${topic}`);
	}

	/**
	 * Unsubscribe from a Kafka topic
	 */
	async unsubscribe(topic: string): Promise<void> {
		this.subscriptions.delete(topic);
		// Note: KafkaJS doesn't support unsubscribing from individual topics
		// Would need to disconnect and reconnect with new subscription list
		console.log(`[KafkaAdapter] Unsubscribed from topic: ${topic}`);
	}

	/**
	 * Check if connected to Kafka
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Health check - verify Kafka connectivity
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;

		try {
			const admin = this.kafka.admin();
			await admin.connect();
			await admin.listTopics();
			await admin.disconnect();
			return true;
		} catch {
			return false;
		}
	}
}

export default KafkaAdapter;
