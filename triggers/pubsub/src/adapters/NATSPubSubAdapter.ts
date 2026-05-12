/**
 * NATSPubSubAdapter — v0.7 PR 6 — Pub/Sub adapter backed by NATS.
 *
 * Two modes:
 *   - **Fan-out** (default, when `consumerGroup` is absent): every
 *     subscriber receives every message on the subject. NATS Core
 *     publish/subscribe semantics — cheapest path, no persistence.
 *   - **Competing-consumer** (when `consumerGroup` is set): NATS
 *     Queue Group — exactly one subscriber in the named group
 *     receives each message. Pure NATS Core.
 *   - **Durable** (when `durable: true`): subscribe via NATS
 *     JetStream consumer so the subscription survives restarts and
 *     replays missed messages from `startFrom`. Required for the
 *     `{seq}` / `{timestamp}` replay cursors.
 *
 * Subject wildcards (`orders.*.created`, `orders.>`) are honored by
 * NATS natively in both modes.
 *
 * Requires `nats` as a peer dependency:
 *
 *     bun add nats
 *
 * Environment variables:
 *   - `NATS_SERVERS`   — comma-separated URLs (default `localhost:4222`).
 *   - `NATS_TOKEN`     — bearer token authentication.
 *   - `NATS_USER` / `NATS_PASS`  — userpass authentication.
 */

import type { PubSubTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { PubSubAdapter, PubSubMessage } from "../PubSubTrigger";

export interface NATSPubSubConfig {
	servers: string[];
	token?: string;
	user?: string;
	pass?: string;
}

interface NatsSubscription {
	unsubscribe: () => void | Promise<void>;
}

interface NatsConnection {
	close: () => Promise<void>;
	drain: () => Promise<void>;
	subscribe: (
		subject: string,
		opts?: { queue?: string; callback?: (err: Error | null, msg: NatsMsg) => void },
	) => NatsSubscription;
	publish: (subject: string, payload: Uint8Array) => void;
	jetstream?: () => NatsJetStream;
	jetstreamManager?: () => Promise<NatsJetStreamManager>;
}

interface NatsJetStream {
	subscribe: (
		subject: string,
		opts?: unknown,
	) => Promise<{
		[Symbol.asyncIterator]: () => AsyncIterator<NatsJsMsg>;
		unsubscribe: () => Promise<void> | void;
	}>;
	publish: (subject: string, payload: Uint8Array) => Promise<unknown>;
}

interface NatsJetStreamManager {
	streams: { add: (config: unknown) => Promise<unknown>; info: (name: string) => Promise<unknown> };
	consumers: { add: (stream: string, config: unknown) => Promise<unknown> };
}

interface NatsMsg {
	subject: string;
	data: Uint8Array;
	sid: number;
	respond?: (data?: Uint8Array) => boolean;
}

interface NatsJsMsg {
	subject: string;
	data: Uint8Array;
	seq: number;
	ack: () => void;
	nak: (millis?: number) => void;
	info: { stream: string; consumer: string; redeliveryCount: number; timestampNanos?: number };
}

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

export class NATSPubSubAdapter implements PubSubAdapter {
	readonly provider = "nats" as const;
	private readonly config: NATSPubSubConfig;
	private conn: NatsConnection | null = null;
	private subscriptions: Map<string, NatsSubscription | { unsubscribe: () => Promise<void> | void }> = new Map();
	private connected = false;

	constructor(config?: Partial<NATSPubSubConfig>) {
		this.config = {
			servers: config?.servers ?? (process.env.NATS_SERVERS ?? "localhost:4222").split(",").map((s) => s.trim()),
			token: config?.token ?? process.env.NATS_TOKEN,
			user: config?.user ?? process.env.NATS_USER,
			pass: config?.pass ?? process.env.NATS_PASS,
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: nats is a runtime peer dep.
			const nats: any = await import("nats");
			this.conn = (await nats.connect({
				servers: this.config.servers,
				token: this.config.token,
				user: this.config.user,
				pass: this.config.pass,
			})) as NatsConnection;
			this.connected = true;
		} catch (err) {
			throw new Error(
				`[blok][pubsub-nats] connect failed: ${(err as Error).message}. Install nats as a peer dependency: bun add nats`,
			);
		}
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		for (const sub of this.subscriptions.values()) {
			try {
				const result = sub.unsubscribe();
				if (result instanceof Promise) await result;
			} catch {
				/* ignore */
			}
		}
		this.subscriptions.clear();
		try {
			await this.conn?.drain();
		} catch {
			/* ignore */
		}
		this.conn = null;
		this.connected = false;
	}

	async subscribe(config: PubSubTriggerOpts, handler: (message: PubSubMessage) => Promise<void>): Promise<void> {
		if (!this.connected || !this.conn) throw new Error("[blok][pubsub-nats] not connected. Call connect() first.");
		const subKey = `${config.topic}#${config.consumerGroup ?? ""}`;

		if (config.durable === true) {
			// JetStream durable subscription — survives restarts.
			if (!this.conn.jetstream) {
				throw new Error("[blok][pubsub-nats] durable subscriptions require JetStream support in the nats client");
			}
			const jsm = await this.conn.jetstreamManager?.();
			if (jsm) {
				// Auto-create a stream covering the subject if one doesn't
				// exist. Production deployments should pre-provision via
				// `nats stream add` to control retention.
				try {
					await jsm.streams.add({
						name: `blok-${(config.topic ?? "").replace(/[^a-zA-Z0-9_]/g, "_")}`,
						subjects: [config.topic],
					});
				} catch {
					/* stream already exists — ignore */
				}
			}
			const js = this.conn.jetstream();
			const startSeq =
				typeof config.startFrom === "object" && config.startFrom && "seq" in config.startFrom
					? config.startFrom.seq
					: undefined;
			const deliverPolicy =
				config.startFrom === "earliest"
					? "all"
					: config.startFrom === "latest"
						? "new"
						: startSeq !== undefined
							? "by_start_sequence"
							: "all";
			const sub = await js.subscribe(config.topic, {
				config: {
					durable_name:
						config.consumerGroup ??
						`blok-${(config.subscription ?? config.topic ?? "default").replace(/[^a-zA-Z0-9_]/g, "_")}`,
					deliver_policy: deliverPolicy,
					opt_start_seq: startSeq,
					ack_policy: config.ack === false ? "none" : "explicit",
				},
			});
			this.subscriptions.set(subKey, { unsubscribe: () => sub.unsubscribe() });
			// Drive the async iterator in a background loop.
			void (async () => {
				try {
					for await (const msg of sub as unknown as AsyncIterable<NatsJsMsg>) {
						await this.dispatchJsMessage(msg, config, handler);
					}
				} catch (err) {
					// Subscription closed or connection lost — let the trigger
					// re-listen via HMR/reconnect logic. Log for visibility.
					console.error(`[blok][pubsub-nats] subscription error: ${(err as Error).message}`);
				}
			})();
			return;
		}

		// Core NATS subscription — fire-and-forget, with optional queue
		// group for competing-consumer semantics.
		const sub = this.conn.subscribe(config.topic, {
			queue: config.consumerGroup,
			callback: (err, msg) => {
				if (err) {
					console.error(`[blok][pubsub-nats] subscribe error: ${err.message}`);
					return;
				}
				void this.dispatchCoreMessage(msg, config, handler);
			},
		});
		this.subscriptions.set(subKey, sub);
	}

	private async dispatchJsMessage(
		msg: NatsJsMsg,
		config: PubSubTriggerOpts,
		handler: (message: PubSubMessage) => Promise<void>,
	): Promise<void> {
		const text = TEXT_DECODER.decode(msg.data);
		let body: unknown = text;
		try {
			body = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			/* leave as text */
		}
		const message: PubSubMessage = {
			id: `${msg.info.stream}:${msg.seq}`,
			body,
			attributes: { subject: msg.subject },
			raw: msg,
			topic: msg.subject,
			subscription: msg.info.consumer,
			publishTime: msg.info.timestampNanos ? new Date(msg.info.timestampNanos / 1e6) : undefined,
			ack: async () => {
				msg.ack();
			},
			nack: async () => {
				msg.nak();
			},
		};
		try {
			await handler(message);
			if (config.ack !== false) msg.ack();
		} catch {
			msg.nak();
		}
	}

	private async dispatchCoreMessage(
		msg: NatsMsg,
		_config: PubSubTriggerOpts,
		handler: (message: PubSubMessage) => Promise<void>,
	): Promise<void> {
		const text = TEXT_DECODER.decode(msg.data);
		let body: unknown = text;
		try {
			body = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			/* leave as text */
		}
		const message: PubSubMessage = {
			id: `${msg.subject}:${msg.sid}:${uuid()}`,
			body,
			attributes: { subject: msg.subject },
			raw: msg,
			topic: msg.subject,
			ack: async () => {
				/* core NATS has no explicit ack */
			},
			nack: async () => {
				/* core NATS has no explicit nack */
			},
		};
		try {
			await handler(message);
		} catch (err) {
			console.error(`[blok][pubsub-nats] handler error: ${(err as Error).message}`);
		}
	}

	async unsubscribe(subscription: string): Promise<void> {
		const sub = this.subscriptions.get(subscription);
		if (!sub) return;
		try {
			const result = sub.unsubscribe();
			if (result instanceof Promise) await result;
		} catch {
			/* ignore */
		}
		this.subscriptions.delete(subscription);
	}

	async publish(topic: string, payload: unknown): Promise<void> {
		if (!this.connected || !this.conn) throw new Error("[blok][pubsub-nats] not connected. Call connect() first.");
		const body = typeof payload === "string" ? payload : JSON.stringify(payload);
		const data = TEXT_ENCODER.encode(body);
		// Prefer JetStream publish when available — durable subscribers
		// require it. Falls back to core publish for fan-out.
		const js = this.conn.jetstream?.();
		if (js) {
			try {
				await js.publish(topic, data);
				return;
			} catch {
				// Stream not configured for this subject — fall back to core.
			}
		}
		this.conn.publish(topic, data);
	}

	isConnected(): boolean {
		return this.connected;
	}

	async healthCheck(): Promise<boolean> {
		return this.connected;
	}
}
