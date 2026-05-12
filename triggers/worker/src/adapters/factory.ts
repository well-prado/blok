/**
 * v0.7 PR 5 — adapter factory.
 *
 * Resolves a `provider` string to a concrete `WorkerAdapter` instance.
 * Used by the `WorkerTrigger` (to pick the right adapter per workflow
 * based on `trigger.worker.provider`) and by the `@blokjs/worker-publish`
 * helper node (to enqueue jobs from any workflow without bundling all
 * broker clients).
 *
 * Provider resolution order:
 *   1. Explicit `provider` field on the workflow (highest priority).
 *   2. `BLOK_WORKER_ADAPTER` env var (per Q7 resolution in the plan).
 *   3. `"in-memory"` fallback (zero-infra default for dev/tests).
 *
 * Each adapter beyond `in-memory` lazy-imports its broker SDK on first
 * use (BullMQ does this today). Workflows that don't use a given
 * provider don't pay the install or import cost.
 */

import type { WorkerProvider } from "@blokjs/helper";
import type { WorkerAdapter } from "../WorkerTrigger";
import { BullMQAdapter } from "./BullMQAdapter";
import { InMemoryAdapter } from "./InMemoryAdapter";
import { KafkaAdapter } from "./KafkaAdapter";
import { NATSWorkerAdapter } from "./NATSAdapter";
import { PgBossAdapter } from "./PgBossAdapter";
import { RabbitMQAdapter } from "./RabbitMQAdapter";
import { RedisStreamsAdapter } from "./RedisStreamsAdapter";
import { SQSAdapter } from "./SQSAdapter";

/**
 * Resolve the effective provider for a workflow. The trigger's
 * `provider` field always wins; otherwise fall back to the
 * `BLOK_WORKER_ADAPTER` env var; otherwise `"in-memory"`.
 */
export function resolveProvider(provider?: WorkerProvider): WorkerProvider {
	if (provider) return provider;
	const envValue = process.env.BLOK_WORKER_ADAPTER;
	if (envValue && isWorkerProvider(envValue)) return envValue;
	return "in-memory";
}

function isWorkerProvider(value: string): value is WorkerProvider {
	return (
		value === "in-memory" ||
		value === "nats" ||
		value === "bullmq" ||
		value === "kafka" ||
		value === "rabbitmq" ||
		value === "sqs" ||
		value === "redis" ||
		value === "pg-boss"
	);
}

/**
 * Construct an adapter for the named provider. Throws a clear error
 * for unknown names — keeps the schema validation and runtime
 * behaviour in sync (the Zod enum catches typos at workflow load).
 */
export function createWorkerAdapter(provider: WorkerProvider): WorkerAdapter {
	switch (provider) {
		case "in-memory":
			return new InMemoryAdapter();
		case "nats":
			return new NATSWorkerAdapter();
		case "bullmq":
			return new BullMQAdapter();
		case "kafka":
			return new KafkaAdapter();
		case "rabbitmq":
			return new RabbitMQAdapter();
		case "sqs":
			return new SQSAdapter();
		case "redis":
			return new RedisStreamsAdapter();
		case "pg-boss":
			return new PgBossAdapter();
		default: {
			const exhaustive: never = provider;
			throw new Error(`[blok][worker] unknown provider "${exhaustive as string}". Check WorkerProviderSchema.`);
		}
	}
}

/**
 * Process-singleton adapter pool — one instance per provider. The
 * trigger calls `getOrCreateAdapter("kafka")` once per workflow, and
 * subsequent workflows on the same provider share the broker
 * connection. Adapters are connected lazily — `getOrCreateAdapter`
 * never connects on its own; the caller calls `adapter.connect()`.
 *
 * Reset via `_resetAdapterPoolForTests()` between vitest suites.
 */
const pool: Map<WorkerProvider, WorkerAdapter> = new Map();

export function getOrCreateAdapter(provider: WorkerProvider): WorkerAdapter {
	let adapter = pool.get(provider);
	if (!adapter) {
		adapter = createWorkerAdapter(provider);
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
