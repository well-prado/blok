import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.7 — publish one message to a pub/sub topic from ANY workflow
 * (HTTP, WebSocket, Webhook, Cron, Worker). Dispatches through the
 * same adapter factory the `PubSubTrigger` uses — same broker
 * connection pool, same provider selection rules.
 *
 * The trigger picks the right adapter from the `provider` field;
 * falls back to `BLOK_PUBSUB_ADAPTER` env var; falls back to NATS.
 *
 * For providers with per-key ordering semantics (Kafka partition key,
 * GCP ordering key), set `partitionKey` to keep related messages on
 * the same partition / consumer.
 */
export default defineNode({
	name: "@blokjs/pubsub-publish",
	description:
		"Publish one message to a pub/sub topic via the same adapter the PubSubTrigger uses. Supports nats, redis-streams, kafka, gcp, aws, azure.",
	input: z.object({
		provider: z
			.enum(["nats", "redis-streams", "kafka", "gcp", "aws", "azure"])
			.optional()
			.describe("Adapter to use. Defaults to BLOK_PUBSUB_ADAPTER env var, then nats."),
		topic: z
			.string()
			.min(1)
			.describe("Topic / subject / stream name. Supports broker-native wildcards on the subscriber side."),
		payload: z.unknown().describe("Message payload. JSON-serialized by the adapter when not a string."),
		partitionKey: z
			.string()
			.optional()
			.describe(
				"Provider-specific per-key ordering hint. Maps to Kafka's message key, GCP's orderingKey, Azure Service Bus's partitionKey, SNS FIFO MessageGroupId.",
			),
		orderingKey: z
			.string()
			.optional()
			.describe(
				"Alias for partitionKey for providers that prefer that name (GCP `orderingKey`, Azure `sessionId`). When both are set, partitionKey wins.",
			),
	}),
	output: z.object({
		topic: z.string(),
		provider: z.string(),
	}),
	async execute(_ctx, input) {
		const moduleName = "@blokjs/trigger-pubsub";
		interface PubSubModule {
			resolveProvider(
				provider?: "nats" | "redis-streams" | "kafka" | "gcp" | "aws" | "azure",
			): "nats" | "redis-streams" | "kafka" | "gcp" | "aws" | "azure";
			getOrCreateAdapter(provider: "nats" | "redis-streams" | "kafka" | "gcp" | "aws" | "azure"): {
				provider: string;
				connect(): Promise<void>;
				isConnected(): boolean;
				publish(topic: string, payload: unknown, opts?: { partitionKey?: string; orderingKey?: string }): Promise<void>;
			};
		}
		let mod: PubSubModule;
		try {
			mod = (await import(moduleName)) as PubSubModule;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`@blokjs/pubsub-publish: cannot load @blokjs/trigger-pubsub (${msg}). Install it as a dependency of the workflow's runtime.`,
			);
		}
		const provider = mod.resolveProvider(input.provider);
		const adapter = mod.getOrCreateAdapter(provider);
		if (!adapter.isConnected()) await adapter.connect();
		await adapter.publish(input.topic, input.payload, {
			partitionKey: input.partitionKey,
			orderingKey: input.orderingKey,
		});
		return { topic: input.topic, provider };
	},
});
