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

import type { QueueTriggerOpts } from "@blokjs/helper";
import type { Consumer, Kafka, KafkaMessage, SASLOptions } from "kafkajs";
import { v4 as uuid } from "uuid";
import type { QueueAdapter, QueueMessage } from "../QueueTrigger";

// `kafkajs` is an optional peer dep — we resolve the runtime constructor
// via `await import("kafkajs")`. The `import type` above is erased at
// compile time so projects that don't install kafkajs can still use this
// trigger as long as they don't actually call the Kafka adapter.
type KafkaCtor = typeof Kafka;
let KafkaClass: KafkaCtor | undefined;

/**
 * Kafka connection configuration
 */
export interface KafkaConfig {
	brokers: string[];
	clientId: string;
	ssl?: boolean;
	/**
	 * SASL auth options — typed as kafkajs's `SASLOptions` (a discriminated
	 * union over the supported mechanisms). Was previously typed inline
	 * with a narrower mechanism enum that didn't satisfy kafkajs's stricter
	 * `SASLOptions | Mechanism` shape.
	 */
	sasl?: SASLOptions;
}

/**
 * KafkaAdapter - Kafka implementation of QueueAdapter
 */
export class KafkaAdapter implements QueueAdapter {
	readonly provider = "kafka" as const;

	private kafka: Kafka | undefined;
	private consumer: Consumer | undefined;

	/**
	 * Type-narrowing accessor for `this.consumer`. The field is undefined
	 * until `connect()` runs; methods that operate on the consumer should
	 * call this so the compiler enforces the precondition without us
	 * sprinkling non-null assertions.
	 */
	private requireConsumer(): Consumer {
		if (!this.consumer) {
			throw new Error("[KafkaAdapter] consumer is not initialised — call connect() first");
		}
		return this.consumer;
	}

	/**
	 * Type-narrowing accessor for `this.kafka`. Same contract as
	 * {@link requireConsumer}.
	 */
	private requireKafka(): Kafka {
		if (!this.kafka) {
			throw new Error("[KafkaAdapter] kafka client is not initialised — call connect() first");
		}
		return this.kafka;
	}
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
			KafkaClass = kafkajs.Kafka;

			this.kafka = new KafkaClass({
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
				`Failed to connect to Kafka: ${(error as Error).message}. Make sure kafkajs is installed: npm install kafkajs`,
			);
		}
	}

	/**
	 * Disconnect from Kafka cluster
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		try {
			await this.requireConsumer().disconnect();
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

		const consumer = this.requireConsumer();

		// Subscribe to topic
		await consumer.subscribe({
			topic,
			fromBeginning: false,
		});

		// Store handler
		this.subscriptions.set(topic, handler);

		// Start consuming if not already running
		await consumer.run({
			eachMessage: async ({
				topic: msgTopic,
				partition,
				message,
			}: {
				topic: string;
				partition: number;
				message: KafkaMessage;
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
							"[KafkaAdapter] Message nack not fully supported in Kafka. " + "Consider implementing dead letter topic.",
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
			const admin = this.requireKafka().admin();
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
