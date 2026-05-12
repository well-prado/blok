/**
 * v0.7 PR 6 — pub/sub adapter factory.
 *
 * Resolves a `provider` string to a concrete `PubSubAdapter` instance.
 * Used by `PubSubTrigger` (per-workflow provider dispatch) and by the
 * `@blokjs/pubsub-publish` helper.
 *
 * Provider resolution order:
 *   1. Explicit `provider` field on the workflow.
 *   2. `BLOK_PUBSUB_ADAPTER` env var.
 *   3. `"nats"` fallback (cheapest infra; matches the v0.7 plan's
 *      "default for pub/sub" recommendation).
 *
 * Each adapter lazy-imports its broker SDK on first use; workflows
 * that don't use a given provider don't pay the install cost.
 */

import type { PubSubProvider } from "@blokjs/helper";
import type { PubSubAdapter } from "../PubSubTrigger";
import { AWSSNSAdapter } from "./AWSSNSAdapter";
import { AzureServiceBusAdapter } from "./AzureServiceBusAdapter";
import { GCPPubSubAdapter } from "./GCPPubSubAdapter";
import { KafkaPubSubAdapter } from "./KafkaPubSubAdapter";
import { NATSPubSubAdapter } from "./NATSPubSubAdapter";
import { RedisStreamsPubSubAdapter } from "./RedisStreamsPubSubAdapter";

export function resolveProvider(provider?: PubSubProvider): PubSubProvider {
	if (provider) return provider;
	const envValue = process.env.BLOK_PUBSUB_ADAPTER;
	if (envValue && isPubSubProvider(envValue)) return envValue;
	return "nats";
}

function isPubSubProvider(value: string): value is PubSubProvider {
	return (
		value === "nats" ||
		value === "redis-streams" ||
		value === "kafka" ||
		value === "gcp" ||
		value === "aws" ||
		value === "azure"
	);
}

export function createPubSubAdapter(provider: PubSubProvider): PubSubAdapter {
	switch (provider) {
		case "nats":
			return new NATSPubSubAdapter();
		case "redis-streams":
			return new RedisStreamsPubSubAdapter();
		case "kafka":
			return new KafkaPubSubAdapter();
		case "gcp":
			return new GCPPubSubAdapter();
		case "aws":
			return new AWSSNSAdapter();
		case "azure":
			return new AzureServiceBusAdapter();
		default: {
			const exhaustive: never = provider;
			throw new Error(`[blok][pubsub] unknown provider "${exhaustive as string}". Check PubSubProviderSchema.`);
		}
	}
}

/**
 * Process-singleton adapter pool — one instance per provider. The
 * trigger calls `getOrCreateAdapter("nats")` once per workflow, and
 * subsequent workflows on the same provider share the broker
 * connection.
 */
const pool: Map<PubSubProvider, PubSubAdapter> = new Map();

export function getOrCreateAdapter(provider: PubSubProvider): PubSubAdapter {
	let adapter = pool.get(provider);
	if (!adapter) {
		adapter = createPubSubAdapter(provider);
		pool.set(provider, adapter);
	}
	return adapter;
}

export function _resetAdapterPoolForTests(): void {
	for (const adapter of pool.values()) {
		void adapter.disconnect?.().catch(() => {});
	}
	pool.clear();
}
