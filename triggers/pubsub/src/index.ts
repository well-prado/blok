/**
 * @blokjs/trigger-pubsub
 *
 * Pub/Sub-based trigger for Blok workflows. Supports 6 providers:
 *
 *   - **NATS** (Core + JetStream) — cheapest infra; subject wildcards.
 *   - **Redis Streams**           — when Redis is already in stack.
 *   - **Kafka**                   — high-throughput streaming.
 *   - **GCP Pub/Sub**             — Google Cloud-locked.
 *   - **AWS SNS+SQS**             — SNS fan-out → SQS queueing.
 *   - **Azure Service Bus**       — Azure Service Bus.
 *
 * v0.7+ — pick the adapter per workflow via `trigger.pubsub.provider`.
 * `BLOK_PUBSUB_ADAPTER` env var sets the default (falls back to NATS).
 * Subclasses can still set `protected adapter` directly for back-
 * compat with the pre-v0.7 single-adapter pattern.
 *
 * **Fan-out vs competing-consumer**: omit `consumerGroup` for fan-out
 * (every subscriber sees every message); set it for competing-consumer
 * (1 of N within group). One field disambiguates the two semantics.
 *
 * @example v0.7 — NATS subject hierarchy with JSON workflow
 * ```json
 * {
 *   "name": "audit-all-order-events",
 *   "trigger": {
 *     "pubsub": {
 *       "provider": "nats",
 *       "topic": "orders.>",
 *       "durable": true,
 *       "startFrom": "earliest"
 *     }
 *   },
 *   "steps": [...]
 * }
 * ```
 */

// Core exports
export {
	PubSubTrigger,
	type PubSubAdapter,
	type PubSubMessage,
} from "./PubSubTrigger";

// Adapters
export { AWSSNSAdapter, type AWSSNSConfig } from "./adapters/AWSSNSAdapter";
export { AzureServiceBusAdapter, type AzureServiceBusConfig } from "./adapters/AzureServiceBusAdapter";
export { GCPPubSubAdapter, type GCPPubSubConfig } from "./adapters/GCPPubSubAdapter";
export { KafkaPubSubAdapter, type KafkaPubSubConfig } from "./adapters/KafkaPubSubAdapter";
export { NATSPubSubAdapter, type NATSPubSubConfig } from "./adapters/NATSPubSubAdapter";
export { RedisStreamsPubSubAdapter, type RedisStreamsPubSubConfig } from "./adapters/RedisStreamsPubSubAdapter";

// v0.7 PR 6 — factory + pool used by PubSubTrigger and exposed for
// helper nodes (`@blokjs/pubsub-publish`).
export {
	_resetAdapterPoolForTests,
	createPubSubAdapter,
	getOrCreateAdapter,
	resolveProvider,
} from "./adapters/factory";

// Re-export types from helper for convenience
export type {
	PubSubProvider,
	PubSubTriggerOpts,
} from "@blokjs/helper";
