/**
 * RedisStreamsPubSubAdapter — v0.7 PR 6 — Pub/Sub adapter backed by
 * Redis Streams via `ioredis`.
 *
 * Pub/Sub vs Worker semantics: this adapter uses **distinct consumer
 * groups per subscriber** so multiple subscribers each receive every
 * message (fan-out). When `consumerGroup` is explicitly set on the
 * workflow, all subscribers in the group compete (1 of N gets each).
 *
 * Replay cursors:
 *   - `"earliest"` / unset → `$` (only new messages by default).
 *   - `"earliest"` with explicit intent → `0` (replay full stream).
 *   - `{seq: N}` → resume from stream id `N-0`.
 *
 * Requires `ioredis` as a peer dependency.
 *
 * Environment variables:
 *   - `REDIS_HOST` (default `localhost`).
 *   - `REDIS_PORT` (default `6379`).
 *   - `REDIS_PASSWORD`.
 *   - `REDIS_DB`.
 */

import type { PubSubTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { PubSubAdapter, PubSubMessage } from "../PubSubTrigger";

export interface RedisStreamsPubSubConfig {
	host: string;
	port: number;
	password?: string;
	db?: number;
	blockMs: number;
	count: number;
}

interface RedisClient {
	xadd(stream: string, ...args: string[]): Promise<string>;
	xreadgroup(...args: string[]): Promise<Array<[string, Array<[string, string[]]>]> | null>;
	xgroup(...args: string[]): Promise<string>;
	xack(stream: string, group: string, ...ids: string[]): Promise<number>;
	ping(): Promise<string>;
	quit(): Promise<string>;
}

interface ActiveSubscription {
	stop: () => void;
}

export class RedisStreamsPubSubAdapter implements PubSubAdapter {
	readonly provider = "redis-streams" as const;
	private readonly config: RedisStreamsPubSubConfig;
	private client: RedisClient | null = null;
	private subscriptions: Map<string, ActiveSubscription> = new Map();
	private connected = false;
	private consumerName = `blok-pubsub-${uuid().slice(0, 8)}`;

	constructor(config?: Partial<RedisStreamsPubSubConfig>) {
		this.config = {
			host: config?.host ?? process.env.REDIS_HOST ?? "localhost",
			port: config?.port ?? Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
			password: config?.password ?? process.env.REDIS_PASSWORD,
			db: config?.db ?? Number.parseInt(process.env.REDIS_DB ?? "0", 10),
			blockMs: config?.blockMs ?? 5000,
			count: config?.count ?? 10,
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: ioredis is a runtime peer dep.
			const ioredis: any = await import("ioredis");
			const IORedis = ioredis.default ?? ioredis.Redis ?? ioredis;
			this.client = new IORedis({
				host: this.config.host,
				port: this.config.port,
				password: this.config.password,
				db: this.config.db,
			}) as RedisClient;
			await this.client.ping();
			this.connected = true;
		} catch (err) {
			throw new Error(
				`[blok][pubsub-redis] connect failed: ${(err as Error).message}. Install ioredis as a peer dependency: bun add ioredis`,
			);
		}
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		for (const sub of this.subscriptions.values()) sub.stop();
		this.subscriptions.clear();
		try {
			await this.client?.quit();
		} catch {
			/* ignore */
		}
		this.client = null;
		this.connected = false;
	}

	async subscribe(config: PubSubTriggerOpts, handler: (message: PubSubMessage) => Promise<void>): Promise<void> {
		if (!this.connected || !this.client) throw new Error("[blok][pubsub-redis] not connected. Call connect() first.");
		const client = this.client;
		const stream = config.topic;
		// Fan-out: each subscriber gets its own group (unique per instance).
		// Competing-consumer: explicit `consumerGroup` makes all subscribers
		// share work.
		const group = config.consumerGroup ?? `blok-fanout-${this.consumerName}-${stream.replace(/[^a-zA-Z0-9_]/g, "_")}`;
		const startId =
			config.startFrom === "earliest"
				? "0"
				: config.startFrom === "latest" || config.startFrom === undefined
					? "$"
					: typeof config.startFrom === "object" && "seq" in config.startFrom
						? `${config.startFrom.seq}-0`
						: "$";

		try {
			await client.xgroup("CREATE", stream, group, startId, "MKSTREAM");
		} catch (err) {
			if (!/BUSYGROUP/i.test((err as Error).message)) throw err;
		}

		let stopped = false;
		const sub: ActiveSubscription = {
			stop: () => {
				stopped = true;
			},
		};
		this.subscriptions.set(`${stream}#${group}`, sub);

		void (async () => {
			while (!stopped) {
				let entries: Array<[string, Array<[string, string[]]>]> | null = null;
				try {
					entries = await client.xreadgroup(
						"GROUP",
						group,
						this.consumerName,
						"COUNT",
						String(this.config.count),
						"BLOCK",
						String(this.config.blockMs),
						"STREAMS",
						stream,
						">",
					);
				} catch {
					await new Promise((r) => setTimeout(r, 1000));
					continue;
				}
				if (!entries) continue;
				for (const [, msgs] of entries) {
					for (const [id, fields] of msgs) {
						if (stopped) break;
						const payload = this.fieldsToObject(fields);
						const dataString = typeof payload.data === "string" ? payload.data : "";
						let body: unknown;
						try {
							body = dataString.length > 0 ? JSON.parse(dataString) : null;
						} catch {
							body = dataString;
						}
						const message: PubSubMessage = {
							id,
							body,
							attributes: payload,
							raw: { id, fields },
							topic: stream,
							subscription: group,
							publishTime: new Date(Number.parseInt(id.split("-")[0] ?? String(Date.now()), 10)),
							ack: async () => {
								await client.xack(stream, group, id);
							},
							nack: async () => {
								/* leave unacked — picked up by XAUTOCLAIM */
							},
						};
						try {
							await handler(message);
							if (config.ack !== false) await client.xack(stream, group, id);
						} catch {
							// Leave unacked — pending entries are visible in XPENDING.
						}
					}
				}
			}
		})();
	}

	private fieldsToObject(fields: string[]): Record<string, string> {
		const out: Record<string, string> = {};
		for (let i = 0; i < fields.length; i += 2) out[fields[i]] = fields[i + 1];
		return out;
	}

	async unsubscribe(subscription: string): Promise<void> {
		const sub = this.subscriptions.get(subscription);
		if (!sub) return;
		sub.stop();
		this.subscriptions.delete(subscription);
	}

	async publish(topic: string, payload: unknown): Promise<void> {
		if (!this.connected || !this.client) throw new Error("[blok][pubsub-redis] not connected. Call connect() first.");
		const body = typeof payload === "string" ? payload : JSON.stringify(payload);
		await this.client.xadd(topic, "*", "data", body);
	}

	isConnected(): boolean {
		return this.connected;
	}

	async healthCheck(): Promise<boolean> {
		if (!this.connected || !this.client) return false;
		try {
			const pong = await this.client.ping();
			return pong === "PONG";
		} catch {
			return false;
		}
	}
}
