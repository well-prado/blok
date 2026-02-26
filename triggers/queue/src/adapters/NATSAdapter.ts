/**
 * NATSAdapter - NATS JetStream queue adapter for QueueTrigger
 *
 * Uses NATS JetStream for persistent message queuing with:
 * - Pull-based consumers for reliable message delivery
 * - Server-side retry config (max_deliver)
 * - Durable consumers for fault tolerance
 * - Work queue semantics via consumer groups
 *
 * Requires: npm install nats
 *
 * Environment variables:
 * - NATS_SERVERS: Comma-separated NATS server URLs (default: localhost:4222)
 * - NATS_TOKEN: Authentication token (optional)
 * - NATS_USER: Username for auth (optional)
 * - NATS_PASS: Password for auth (optional)
 * - NATS_STREAM_NAME: JetStream stream name (default: blok-queue)
 */

import type { QueueTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { QueueAdapter, QueueMessage } from "../QueueTrigger";

/**
 * NATS connection configuration
 */
export interface NATSConfig {
	/** NATS server URLs */
	servers: string[];
	/** Authentication token */
	token?: string;
	/** Username */
	user?: string;
	/** Password */
	pass?: string;
	/** JetStream stream name (default: "blok-queue") */
	streamName?: string;
	/** Durable consumer name prefix (default: "blok") */
	durablePrefix?: string;
}

/**
 * NATSAdapter - NATS JetStream implementation of QueueAdapter
 */
export class NATSAdapter implements QueueAdapter {
	readonly provider = "nats" as const;

	// biome-ignore lint/suspicious/noExplicitAny: NATS types are dynamically imported (optional peer dependency)
	private nc: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: NATS types are dynamically imported
	private js: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: NATS types are dynamically imported
	private jsm: any = null;
	private connected = false;
	private config: NATSConfig;
	// biome-ignore lint/suspicious/noExplicitAny: NATS consumer instances
	private consumers: Map<string, any> = new Map();
	// biome-ignore lint/suspicious/noExplicitAny: NATS consume iterators
	private consumeIterators: Map<string, any> = new Map();

	constructor(config?: Partial<NATSConfig>) {
		this.config = {
			servers: config?.servers || (process.env.NATS_SERVERS || "localhost:4222").split(","),
			token: config?.token || process.env.NATS_TOKEN,
			user: config?.user || process.env.NATS_USER,
			pass: config?.pass || process.env.NATS_PASS,
			streamName: config?.streamName || process.env.NATS_STREAM_NAME || "blok-queue",
			durablePrefix: config?.durablePrefix || "blok",
		};
	}

	/**
	 * Connect to NATS and initialize JetStream
	 */
	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			const nats = await import("nats");

			const connectOpts: Record<string, unknown> = {
				servers: this.config.servers,
			};

			if (this.config.token) connectOpts.token = this.config.token;
			if (this.config.user) connectOpts.user = this.config.user;
			if (this.config.pass) connectOpts.pass = this.config.pass;

			this.nc = await nats.connect(connectOpts);
			this.js = this.nc.jetstream();
			this.jsm = await this.nc.jetstreamManager();

			this.connected = true;
			console.log(`[NATSAdapter] Connected to NATS: ${this.config.servers.join(", ")}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to NATS: ${(error as Error).message}. Make sure nats is installed: npm install nats`,
			);
		}
	}

	/**
	 * Disconnect from NATS (drain all subscriptions)
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		try {
			// Stop all consume iterators
			for (const [, iter] of this.consumeIterators) {
				try {
					iter.stop();
				} catch {
					// Iterator may already be stopped
				}
			}
			this.consumeIterators.clear();
			this.consumers.clear();

			// Drain gracefully closes the connection
			await this.nc.drain();
			this.connected = false;
			console.log("[NATSAdapter] Disconnected from NATS");
		} catch (error) {
			console.error(`[NATSAdapter] Error disconnecting: ${(error as Error).message}`);
		}
	}

	/**
	 * Subscribe to a NATS JetStream subject
	 */
	async subscribe(config: QueueTriggerOpts, handler: (message: QueueMessage) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected to NATS. Call connect() first.");
		}

		const nats = await import("nats");
		const topic = config.topic;
		const streamName = this.config.streamName || "blok-queue";
		const durableName = config.consumerGroup || `${this.config.durablePrefix}-${topic.replace(/[.>*]/g, "-")}`;

		// Ensure the stream exists with the topic as a subject
		await this.ensureStream(streamName, [`${topic}`, `${topic}.>`]);

		// Create or update durable pull consumer
		await this.jsm.consumers.add(streamName, {
			durable_name: durableName,
			ack_policy: nats.AckPolicy.Explicit,
			max_deliver: config.maxRetries ?? 3,
			ack_wait: (config.retryDelay ?? 30000) * 1_000_000, // Convert ms to nanoseconds
			filter_subjects: [topic, `${topic}.>`],
		});

		// Get consumer handle
		const consumer = await this.js.consumers.get(streamName, durableName);
		this.consumers.set(topic, consumer);

		// Start consuming messages
		const iter = await consumer.consume();
		this.consumeIterators.set(topic, iter);

		// Process messages in background
		(async () => {
			for await (const msg of iter) {
				try {
					// Parse message body
					let body: unknown;
					try {
						const codec = nats.JSONCodec();
						body = codec.decode(msg.data);
					} catch {
						try {
							const sc = nats.StringCodec();
							const text = sc.decode(msg.data);
							body = JSON.parse(text);
						} catch {
							body = msg.data;
						}
					}

					// Parse headers
					const headers: Record<string, string> = {};
					if (msg.headers) {
						for (const [key, values] of msg.headers) {
							headers[key] = Array.isArray(values) ? values[0] : values;
						}
					}

					// Create queue message
					const queueMessage: QueueMessage = {
						id: headers["x-message-id"] || msg.headers?.get("Nats-Msg-Id") || uuid(),
						body,
						headers,
						raw: msg,
						topic: msg.subject,
						timestamp: new Date(),
						ack: async () => {
							msg.ack();
						},
						nack: async (requeue?: boolean) => {
							if (requeue) {
								// nak() tells the server to redeliver the message
								msg.nak();
							} else {
								// term() terminates delivery — message won't be redelivered
								msg.term();
							}
						},
					};

					await handler(queueMessage);
				} catch (error) {
					console.error(`[NATSAdapter] Error processing message: ${(error as Error).message}`);
					// Nak the message for retry
					try {
						msg.nak();
					} catch {
						// Message may already be acked/nacked
					}
				}
			}
		})();

		console.log(`[NATSAdapter] Subscribed to subject: ${topic} (stream: ${streamName}, consumer: ${durableName})`);
	}

	/**
	 * Unsubscribe from a NATS subject
	 */
	async unsubscribe(topic: string): Promise<void> {
		const iter = this.consumeIterators.get(topic);
		if (iter) {
			try {
				iter.stop();
			} catch {
				// Iterator may already be stopped
			}
			this.consumeIterators.delete(topic);
		}
		this.consumers.delete(topic);
		console.log(`[NATSAdapter] Unsubscribed from subject: ${topic}`);
	}

	/**
	 * Check if connected to NATS
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Health check — verify NATS connectivity
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected || !this.nc) return false;

		try {
			// Check connection is still alive by accessing server info
			const info = this.nc.info;
			return info !== undefined;
		} catch {
			return false;
		}
	}

	/**
	 * Ensure a JetStream stream exists with the given subjects.
	 * Idempotent — updates the stream if it already exists with new subjects.
	 */
	private async ensureStream(name: string, subjects: string[]): Promise<void> {
		try {
			// Try to get existing stream info
			const info = await this.jsm.streams.info(name);

			// Merge new subjects with existing ones
			const existingSubjects = info.config.subjects || [];
			const allSubjects = [...new Set([...existingSubjects, ...subjects])];

			// Update stream if subjects changed
			if (allSubjects.length !== existingSubjects.length) {
				await this.jsm.streams.update(name, {
					...info.config,
					subjects: allSubjects,
				});
			}
		} catch {
			// Stream doesn't exist, create it
			await this.jsm.streams.add({
				name,
				subjects,
				// biome-ignore lint/suspicious/noExplicitAny: nats JetStream retention policy enum
				retention: "workqueue" as any,
				max_deliver: 3,
				// biome-ignore lint/suspicious/noExplicitAny: nats JetStream storage type enum
				storage: "file" as any,
			});
		}
	}
}

export default NATSAdapter;
