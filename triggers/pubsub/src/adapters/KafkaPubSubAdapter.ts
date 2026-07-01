/**
 * KafkaPubSubAdapter — v0.7 PR 6 — Pub/Sub adapter backed by Apache
 * Kafka via `kafkajs`.
 *
 * Pub/Sub vs Worker semantics: this adapter uses **per-subscriber
 * consumer groups** so multiple subscribers each receive every message
 * (fan-out). When `consumerGroup` is explicitly set, all subscribers
 * share that group and compete (1 of N gets each message).
 *
 * Replay cursors via `startFrom`:
 *   - `"earliest"` → `fromBeginning: true` on first subscribe.
 *   - `"latest"` (default) → only new messages.
 *   - `{seq: N}` / `{timestamp: ms}` — provider-specific. Cleanest
 *     long-term path is Kafka's `admin.seek({offset|timestamp})` post-
 *     subscribe; v1 honors `earliest` / `latest` and `{seq}` via
 *     `auto.offset.reset` only.
 *
 * Requires `kafkajs` as a peer dependency.
 *
 * Environment variables:
 *   - `KAFKA_BROKERS`           — comma-separated (default `localhost:9092`).
 *   - `KAFKA_CLIENT_ID`         — default `"blok-pubsub"`.
 *   - `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD`  — SASL/PLAIN.
 *   - `KAFKA_SSL`               — `"true"` enables TLS.
 */

import type { PubSubTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { PubSubAdapter, PubSubMessage } from "../PubSubTrigger";

export interface KafkaPubSubConfig {
	brokers: string[];
	clientId: string;
	saslUsername?: string;
	saslPassword?: string;
	ssl: boolean;
}

interface KafkaConsumerHandle {
	disconnect: () => Promise<void>;
	stop: () => Promise<void>;
}

export class KafkaPubSubAdapter implements PubSubAdapter {
	readonly provider = "kafka" as const;
	private readonly config: KafkaPubSubConfig;
	// biome-ignore lint/suspicious/noExplicitAny: kafkajs's exported `Kafka` constructor is loosely typed.
	private kafka: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: producer is created lazily and typed loosely.
	private producer: any = null;
	private consumers: Map<string, KafkaConsumerHandle> = new Map();
	private connected = false;

	constructor(config?: Partial<KafkaPubSubConfig>) {
		this.config = {
			brokers: config?.brokers ?? (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((s) => s.trim()),
			clientId: config?.clientId ?? process.env.KAFKA_CLIENT_ID ?? "blok-pubsub",
			saslUsername: config?.saslUsername ?? process.env.KAFKA_SASL_USERNAME,
			saslPassword: config?.saslPassword ?? process.env.KAFKA_SASL_PASSWORD,
			ssl: config?.ssl ?? process.env.KAFKA_SSL === "true",
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: kafkajs is a runtime peer dep.
			const kafkajs: any = await import("kafkajs");
			const sasl =
				this.config.saslUsername && this.config.saslPassword
					? { mechanism: "plain", username: this.config.saslUsername, password: this.config.saslPassword }
					: undefined;
			this.kafka = new kafkajs.Kafka({
				clientId: this.config.clientId,
				brokers: this.config.brokers,
				ssl: this.config.ssl,
				sasl,
			});
			this.producer = this.kafka.producer();
			await this.producer.connect();
			this.connected = true;
		} catch (err) {
			throw new Error(
				`[blok][pubsub-kafka] connect failed: ${(err as Error).message}. Install kafkajs as a peer dependency: bun add kafkajs`,
			);
		}
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		for (const consumer of this.consumers.values()) {
			try {
				await consumer.disconnect();
			} catch {
				/* ignore */
			}
		}
		this.consumers.clear();
		try {
			await this.producer?.disconnect();
		} catch {
			/* ignore */
		}
		this.producer = null;
		this.connected = false;
	}

	async subscribe(config: PubSubTriggerOpts, handler: (message: PubSubMessage) => Promise<void>): Promise<void> {
		if (!this.connected) throw new Error("[blok][pubsub-kafka] not connected. Call connect() first.");
		// Fan-out: distinct group id per subscriber instance. Competing-
		// consumer: explicit consumerGroup shared across all subscribers.
		const groupId =
			config.consumerGroup ?? `blok-fanout-${uuid().slice(0, 8)}-${config.topic.replace(/[^a-zA-Z0-9_]/g, "_")}`;
		const consumer = this.kafka.consumer({ groupId });
		await consumer.connect();
		const fromBeginning = config.startFrom === "earliest";
		await consumer.subscribe({ topic: config.topic, fromBeginning });
		this.consumers.set(`${config.topic}#${groupId}`, consumer);

		await consumer.run({
			autoCommit: config.ack !== false,
			eachMessage: async ({
				message,
			}: {
				message: { key?: Buffer; value?: Buffer; offset: string; timestamp: string; headers?: Record<string, Buffer> };
			}) => {
				const text = message.value?.toString("utf8") ?? "";
				let body: unknown = text;
				try {
					body = text.length > 0 ? JSON.parse(text) : null;
				} catch {
					/* leave as text */
				}
				const attributes: Record<string, string> = {};
				if (message.headers) {
					for (const [k, v] of Object.entries(message.headers)) attributes[k] = v?.toString("utf8") ?? "";
				}
				// kafkajs has no per-message nack; the ONLY way to suppress the
				// auto-commit of a failed offset is to throw out of eachMessage.
				// PubSubTrigger.handleMessage catches handler errors and calls
				// nack() (it never re-throws), so without this flag the offset
				// would auto-commit and the failed message would be lost. We set
				// a flag on nack() and throw after the handler returns.
				let nacked = false;
				const msg: PubSubMessage = {
					id: `${config.topic}:${message.offset}`,
					body,
					attributes,
					raw: message,
					topic: config.topic,
					subscription: groupId,
					publishTime: new Date(Number.parseInt(message.timestamp, 10)),
					ack: async () => {
						/* autoCommit handles ack */
					},
					nack: async () => {
						nacked = true;
					},
				};
				await handler(msg);
				// At-least-once (default): a nacked message must NOT be
				// committed — throw so kafkajs redelivers it. At-most-once
				// (ack:false) never commits per-message anyway, so a nack is a
				// no-op there (the message is considered consumed once).
				if (nacked && config.ack !== false) {
					throw new Error(`[blok][pubsub-kafka] message ${msg.id} nacked — suppressing offset commit for redelivery`);
				}
			},
		});
	}

	async unsubscribe(subscription: string): Promise<void> {
		const consumer = this.consumers.get(subscription);
		if (!consumer) return;
		try {
			await consumer.stop();
			await consumer.disconnect();
		} catch {
			/* ignore */
		}
		this.consumers.delete(subscription);
	}

	async publish(
		topic: string,
		payload: unknown,
		opts?: { partitionKey?: string; orderingKey?: string },
	): Promise<void> {
		if (!this.connected || !this.producer) throw new Error("[blok][pubsub-kafka] not connected. Call connect() first.");
		const body = typeof payload === "string" ? payload : JSON.stringify(payload);
		const key = opts?.partitionKey ?? opts?.orderingKey;
		await this.producer.send({
			topic,
			messages: [{ key, value: body }],
		});
	}

	isConnected(): boolean {
		return this.connected;
	}

	async healthCheck(): Promise<boolean> {
		return this.connected;
	}
}
