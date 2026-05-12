/**
 * WebSocket cross-process broadcast backplane — v0.7 follow-up.
 *
 * In single-process deployments the WS trigger's `broadcastToRoom`
 * iterates its local `rooms` map and is done. In multi-process
 * deployments (horizontally-scaled WS workers behind a load balancer)
 * a message published by process A's `broadcastToRoom` ALSO needs to
 * reach process B's connections in the same workflow-scoped room.
 *
 * **Mechanism.** When opted in via `BLOK_WS_BACKPLANE=<provider>`
 * (or constructor config), the WS trigger:
 *
 *   1. **Subscribes** to a well-known pub/sub topic (default
 *      `__blok_ws_broadcast`) at `listen()` time, via the same
 *      adapter factory the PubSubTrigger uses (PR 6). Every WS
 *      worker in the cluster joins the same fan-out topic.
 *   2. **Publishes** every broadcast envelope to the topic.
 *      Envelopes carry `workflowName`, `room`, `data` (string or
 *      base64-encoded binary), `exceptConnectionId`, and `senderId`
 *      (this process's uuid).
 *   3. **Receives** envelopes from peers and re-runs the local
 *      fan-out — skipping its own publishes via the `senderId`
 *      check so messages don't echo back.
 *
 * Provider is picked via the pub/sub factory — supports `nats`,
 * `redis-streams`, `kafka`, `gcp`, `aws`, `azure` (whichever the
 * operator's stack runs). For dev / tests / single-process
 * deployments, leave the env unset and the backplane is a no-op.
 *
 * Binary frames (Uint8Array, ArrayBuffer) are encoded base64 in the
 * envelope so JSON serialization round-trips cleanly across the
 * broker. Text frames pass through as strings. The receive path
 * decodes back to the original shape before handing to local
 * `WSContext.send`.
 */

import { v4 as uuid } from "uuid";

/**
 * The publish/subscribe API surface the backplane needs. Compatible
 * with `@blokjs/trigger-pubsub`'s `PubSubAdapter` interface so any of
 * the 6 v0.7 adapters can be dropped in.
 *
 * Type-loose `unknown` for inputs/outputs because we lazy-import the
 * pubsub trigger at runtime to keep the WS package free of broker
 * SDKs in workflows that don't use the backplane.
 */
export interface BackplaneAdapter {
	readonly provider: string;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	publish(topic: string, payload: unknown, opts?: { partitionKey?: string }): Promise<void>;
	subscribe(
		config: { topic: string; consumerGroup?: string },
		handler: (msg: { body: unknown; topic: string; subscription?: string }) => Promise<void>,
	): Promise<void>;
}

/**
 * Cross-process broadcast envelope. Serialised to JSON on publish,
 * parsed on receive. Binary frames are base64-encoded so the envelope
 * is always JSON-safe.
 */
export interface BroadcastEnvelope {
	/** Process uuid of the publishing WS worker; receiver skips its own publishes. */
	senderId: string;
	/** Workflow-scoped room key (already includes the `<workflowName>:` prefix). */
	roomKey: string;
	/** Optional connection id to skip on the receiving side (`exceptSelf` semantics). */
	exceptConnectionId?: string;
	/** Encoded payload — `{kind: "text", value: string}` or `{kind: "binary", base64: string}`. */
	payload: { kind: "text"; value: string } | { kind: "binary"; base64: string };
}

export const DEFAULT_BACKPLANE_TOPIC = "__blok_ws_broadcast";

/**
 * Build the broadcast envelope from a local fan-out call's
 * arguments. Used by `WebSocketTrigger.broadcastToRoom` on the
 * publish path.
 */
export function encodeEnvelope(
	senderId: string,
	roomKey: string,
	data: string | ArrayBuffer | Uint8Array,
	exceptConnectionId?: string,
): BroadcastEnvelope {
	if (typeof data === "string") {
		return { senderId, roomKey, exceptConnectionId, payload: { kind: "text", value: data } };
	}
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const base64 = Buffer.from(bytes).toString("base64");
	return { senderId, roomKey, exceptConnectionId, payload: { kind: "binary", base64 } };
}

/**
 * Decode a received envelope back to the WS-ready payload shape.
 * The receive handler hands this directly to `WSContext.send`.
 */
export function decodePayload(envelope: BroadcastEnvelope): string | Uint8Array {
	if (envelope.payload.kind === "text") return envelope.payload.value;
	return new Uint8Array(Buffer.from(envelope.payload.base64, "base64"));
}

/**
 * Generate this WS worker's senderId. Stable for the lifetime of
 * the WebSocketTrigger instance; used to skip self-echoes on the
 * subscribe handler.
 */
export function newSenderId(): string {
	return `ws-${uuid()}`;
}

/**
 * Backplane configuration. Resolution order at trigger construction:
 *
 *   1. Explicit `BackplaneConfig` passed to the constructor.
 *   2. `BLOK_WS_BACKPLANE` env var — the provider name (e.g. `nats`).
 *      Topic + consumerGroup honor `BLOK_WS_BACKPLANE_TOPIC` and
 *      `BLOK_WS_BACKPLANE_GROUP` when set; otherwise default to
 *      `__blok_ws_broadcast` and undefined (fan-out).
 *   3. Disabled — single-process behavior, no backplane connection.
 */
export interface BackplaneConfig {
	provider: "nats" | "redis-streams" | "kafka" | "gcp" | "aws" | "azure";
	topic?: string;
	consumerGroup?: string;
}

export function resolveBackplaneConfig(explicit?: BackplaneConfig): BackplaneConfig | null {
	if (explicit) return explicit;
	const envProvider = process.env.BLOK_WS_BACKPLANE;
	// `process.env.X = undefined` in Node.js stores the literal string
	// "undefined" instead of unsetting the var — defensive check below.
	if (!envProvider || envProvider === "undefined") return null;
	const valid: ReadonlyArray<BackplaneConfig["provider"]> = ["nats", "redis-streams", "kafka", "gcp", "aws", "azure"];
	if (!(valid as readonly string[]).includes(envProvider)) return null;
	const topicEnv = process.env.BLOK_WS_BACKPLANE_TOPIC;
	const groupEnv = process.env.BLOK_WS_BACKPLANE_GROUP;
	return {
		provider: envProvider as BackplaneConfig["provider"],
		topic: topicEnv && topicEnv !== "undefined" ? topicEnv : DEFAULT_BACKPLANE_TOPIC,
		consumerGroup: groupEnv && groupEnv !== "undefined" ? groupEnv : undefined,
	};
}

/**
 * Lazy-load the v0.7 pub/sub factory and instantiate an adapter for
 * the chosen provider. Returns the adapter, ready for `connect()`.
 * Throws if `@blokjs/trigger-pubsub` is not installed.
 */
export async function createBackplaneAdapter(config: BackplaneConfig): Promise<BackplaneAdapter> {
	const moduleName = "@blokjs/trigger-pubsub";
	interface PubSubModule {
		getOrCreateAdapter(provider: BackplaneConfig["provider"]): BackplaneAdapter;
	}
	let mod: PubSubModule;
	try {
		mod = (await import(moduleName)) as PubSubModule;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`[blok][ws-backplane] cannot load @blokjs/trigger-pubsub (${msg}). Install it to enable the cross-process WS broadcast backplane.`,
		);
	}
	return mod.getOrCreateAdapter(config.provider);
}
