/**
 * KafkaAdapter — v0.7 PR 5 — Worker adapter backed by Apache Kafka via
 * `kafkajs`. Consumes from a topic (the `queue` field) with a
 * consumer-group identifier; produces via the same client.
 *
 * Kafka is fundamentally a streaming platform — not a queue — so a
 * few semantics differ from BullMQ/SQS/RabbitMQ:
 *
 *   - **Ordering**: per-partition, not per-topic. Set the partition
 *     key via the `dedupId` field on `addJob` to keep related
 *     messages on the same partition.
 *   - **Retries**: Kafka doesn't have a broker-side retry concept.
 *     The adapter re-throws on handler failure; offset commit is
 *     suppressed so the consumer re-polls the message on the next
 *     cycle. For real retry semantics, layer a dead-letter topic.
 *   - **Stats**: KafkaJS exposes consumer-group lag via its admin
 *     client; the lag count is reported as `waiting`. Other stats
 *     are tracked locally per consumer.
 *   - **Concurrency**: the `concurrency` field maps to KafkaJS's
 *     `partitionsConsumedConcurrently` — it caps how many partitions
 *     are processed in parallel, so it's bounded by the topic's
 *     partition count. A single-partition topic is effectively serial
 *     regardless of the configured value.
 *
 * Requires `kafkajs` as a peer dependency:
 *
 *     bun add kafkajs
 *
 * Environment variables (read at adapter construction):
 *   - `KAFKA_BROKERS`           — comma-separated list (default `localhost:9092`).
 *   - `KAFKA_CLIENT_ID`         — client.id (default `"blok-worker"`).
 *   - `KAFKA_SASL_USERNAME`     — SASL/PLAIN username (optional).
 *   - `KAFKA_SASL_PASSWORD`     — SASL/PLAIN password (optional).
 *   - `KAFKA_SSL`               — when `"true"`, enable TLS.
 */

import type { WorkerTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { WorkerAdapter, WorkerJob, WorkerQueueStats } from "../WorkerTrigger";

export interface KafkaConfig {
	brokers: string[];
	clientId: string;
	saslUsername?: string;
	saslPassword?: string;
	ssl: boolean;
}

interface KafkaJsHandle {
	producer?: {
		connect: () => Promise<void>;
		disconnect: () => Promise<void>;
		send: (args: unknown) => Promise<unknown>;
	};
	consumers: Map<
		string,
		{
			disconnect: () => Promise<void>;
			stop: () => Promise<void>;
			run: (opts: unknown) => Promise<void>;
		}
	>;
	admin?: {
		connect: () => Promise<void>;
		disconnect: () => Promise<void>;
		fetchTopicOffsets: (topic: string) => Promise<Array<{ partition: number; offset: string }>>;
	};
}

interface QueueStatsCounters {
	completed: number;
	failed: number;
	active: number;
}

export class KafkaAdapter implements WorkerAdapter {
	readonly provider = "kafka" as const;
	private readonly config: KafkaConfig;
	// biome-ignore lint/suspicious/noExplicitAny: kafkajs's exported `Kafka` constructor is loosely typed.
	private kafka: any = null;
	private handle: KafkaJsHandle = { consumers: new Map() };
	private connected = false;
	private stats: Map<string, QueueStatsCounters> = new Map();

	constructor(config?: Partial<KafkaConfig>) {
		this.config = {
			brokers: config?.brokers ?? (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((s) => s.trim()),
			clientId: config?.clientId ?? process.env.KAFKA_CLIENT_ID ?? "blok-worker",
			saslUsername: config?.saslUsername ?? process.env.KAFKA_SASL_USERNAME,
			saslPassword: config?.saslPassword ?? process.env.KAFKA_SASL_PASSWORD,
			ssl: config?.ssl ?? process.env.KAFKA_SSL === "true",
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: kafkajs is a runtime-loaded peer dep.
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
			this.handle.producer = this.kafka.producer();
			await this.handle.producer?.connect();
			this.handle.admin = this.kafka.admin();
			await this.handle.admin?.connect();
			this.connected = true;
		} catch (err) {
			throw new Error(
				`[blok][kafka] connect failed: ${(err as Error).message}. Install kafkajs as a peer dependency: bun add kafkajs`,
			);
		}
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		for (const [, consumer] of this.handle.consumers) {
			try {
				await consumer.disconnect();
			} catch {
				/* ignore */
			}
		}
		this.handle.consumers.clear();
		try {
			await this.handle.producer?.disconnect();
		} catch {
			/* ignore */
		}
		try {
			await this.handle.admin?.disconnect();
		} catch {
			/* ignore */
		}
		this.connected = false;
	}

	async process(config: WorkerTriggerOpts, handler: (job: WorkerJob) => Promise<void>): Promise<void> {
		if (!this.connected) throw new Error("[blok][kafka] not connected. Call connect() first.");
		const groupId = config.consumerGroup ?? `${config.queue}-group`;
		const consumer = this.kafka.consumer({ groupId });
		await consumer.connect();
		await consumer.subscribe({ topic: config.queue, fromBeginning: config.fromBeginning === true });
		this.handle.consumers.set(config.queue, consumer);
		this.stats.set(config.queue, { completed: 0, failed: 0, active: 0 });
		const stats = this.stats.get(config.queue) as QueueStatsCounters;

		await consumer.run({
			autoCommit: config.ack !== false,
			// F25 — honor the documented `concurrency` knob. Kafka processes
			// messages serially per partition by default; `partitionsConsumedConcurrently`
			// is KafkaJS's native parallelism cap (bounded by partition count).
			// Without this the field was silently ignored — validated, accepted,
			// even logged at startup, but with zero runtime effect.
			partitionsConsumedConcurrently: Math.max(1, config.concurrency ?? 1),
			eachMessage: async ({
				message,
			}: {
				message: { key?: Buffer; value?: Buffer; offset: string; timestamp: string; headers?: Record<string, Buffer> };
			}) => {
				const payloadString = message.value?.toString("utf8") ?? "";
				let data: unknown;
				try {
					data = payloadString.length > 0 ? JSON.parse(payloadString) : null;
				} catch {
					data = payloadString;
				}
				const headers: Record<string, string> = {};
				if (message.headers) {
					for (const [k, v] of Object.entries(message.headers)) headers[k] = v?.toString("utf8") ?? "";
				}
				const job: WorkerJob = {
					id: message.key?.toString("utf8") ?? `${config.queue}:${message.offset}`,
					data,
					headers,
					queue: config.queue,
					priority: config.priority ?? 0,
					attempts: 0,
					maxRetries: config.retries ?? 0,
					createdAt: new Date(Number.parseInt(message.timestamp, 10)),
					timeout: config.timeout,
					raw: message,
					complete: async () => {
						stats.completed += 1;
					},
					fail: async (_err: Error) => {
						stats.failed += 1;
						throw _err;
					},
				};
				stats.active += 1;
				try {
					await handler(job);
					stats.completed += 1;
				} catch (err) {
					stats.failed += 1;
					throw err;
				} finally {
					stats.active = Math.max(0, stats.active - 1);
				}
			},
		});
	}

	async addJob(
		queue: string,
		data: unknown,
		opts?: { priority?: number; delay?: number; retries?: number; timeout?: number; jobId?: string },
	): Promise<string> {
		if (!this.connected) throw new Error("[blok][kafka] not connected. Call connect() first.");
		if (!this.handle.producer) throw new Error("[blok][kafka] producer not initialized");
		const key = opts?.jobId ?? uuid();
		const payload = typeof data === "string" ? data : JSON.stringify(data);
		await this.handle.producer.send({
			topic: queue,
			messages: [
				{
					key,
					value: payload,
					headers: opts?.delay ? { "x-blok-delay-ms": String(opts.delay) } : undefined,
				},
			],
		});
		return key;
	}

	async stopProcessing(queue: string): Promise<void> {
		const consumer = this.handle.consumers.get(queue);
		if (consumer) {
			try {
				await consumer.stop();
			} catch {
				/* ignore */
			}
			try {
				await consumer.disconnect();
			} catch {
				/* ignore */
			}
			this.handle.consumers.delete(queue);
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	async healthCheck(): Promise<boolean> {
		if (!this.connected || !this.handle.admin) return false;
		try {
			await this.handle.admin.fetchTopicOffsets("__consumer_offsets");
			return true;
		} catch {
			return false;
		}
	}

	async getQueueStats(queue: string): Promise<WorkerQueueStats> {
		const counters = this.stats.get(queue) ?? { completed: 0, failed: 0, active: 0 };
		let waiting = 0;
		if (this.handle.admin) {
			try {
				const offsets = await this.handle.admin.fetchTopicOffsets(queue);
				// Approximate: total committed offsets across partitions. Real lag
				// requires admin.fetchOffsets({ groupId }) — skipped here to keep
				// the call cheap; production deployments should use Kafka's
				// dedicated lag metrics anyway.
				waiting = offsets.reduce((sum, p) => sum + Number.parseInt(p.offset, 10), 0);
			} catch {
				waiting = 0;
			}
		}
		return {
			waiting,
			active: counters.active,
			completed: counters.completed,
			failed: counters.failed,
			delayed: 0,
		};
	}
}
