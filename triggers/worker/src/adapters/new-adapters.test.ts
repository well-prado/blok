/**
 * Smoke tests for the v0.7 PR 5 adapters (Kafka, RabbitMQ, SQS, Redis
 * Streams, pg-boss). Each adapter is exercised at the boundaries
 * that don't require a live broker connection:
 *
 *   - Constructor + provider name + initial connected state.
 *   - `disconnect()` is a no-op before connect.
 *
 * The peer-dep error paths and the broker round-trips need real
 * brokers — those live in the docker-compose integration suite that
 * we'll wire up as a follow-up (see PR 5 plan, "Out of scope:
 * docker-compose CI").
 */

import { describe, expect, it } from "vitest";

import { KafkaAdapter } from "./KafkaAdapter";
import { PgBossAdapter } from "./PgBossAdapter";
import { RabbitMQAdapter } from "./RabbitMQAdapter";
import { RedisStreamsAdapter } from "./RedisStreamsAdapter";
import { SQSAdapter } from "./SQSAdapter";

describe("KafkaAdapter — v0.7 PR 5", () => {
	it("reports provider 'kafka'", () => {
		expect(new KafkaAdapter().provider).toBe("kafka");
	});

	it("is not connected before connect()", () => {
		expect(new KafkaAdapter().isConnected()).toBe(false);
	});

	it("disconnect() before connect is a no-op", async () => {
		await expect(new KafkaAdapter().disconnect()).resolves.toBeUndefined();
	});

	it("reads broker list from KAFKA_BROKERS env var", () => {
		process.env.KAFKA_BROKERS = "broker-a:9092,broker-b:9092";
		const adapter = new KafkaAdapter();
		expect((adapter as unknown as { config: { brokers: string[] } }).config.brokers).toEqual([
			"broker-a:9092",
			"broker-b:9092",
		]);
		process.env.KAFKA_BROKERS = undefined;
	});

	// F25 — the `concurrency` field maps to KafkaJS's
	// `partitionsConsumedConcurrently`. Pre-fix it was silently ignored.
	it("passes concurrency to consumer.run as partitionsConsumedConcurrently", async () => {
		const adapter = new KafkaAdapter();
		let captured: { partitionsConsumedConcurrently?: number } | undefined;
		const fakeConsumer = {
			connect: async () => {},
			subscribe: async () => {},
			run: async (opts: { partitionsConsumedConcurrently?: number }) => {
				captured = opts;
			},
			stop: async () => {},
			disconnect: async () => {},
		};
		// Inject a connected kafka client whose consumer() returns our fake.
		(adapter as unknown as { connected: boolean }).connected = true;
		(adapter as unknown as { kafka: unknown }).kafka = { consumer: () => fakeConsumer };

		await adapter.process({ queue: "events", concurrency: 7, retries: 0, priority: 0 }, async () => {});

		expect(captured?.partitionsConsumedConcurrently).toBe(7);
	});

	it("defaults partitionsConsumedConcurrently to 1 when concurrency is unset", async () => {
		const adapter = new KafkaAdapter();
		let captured: { partitionsConsumedConcurrently?: number } | undefined;
		const fakeConsumer = {
			connect: async () => {},
			subscribe: async () => {},
			run: async (opts: { partitionsConsumedConcurrently?: number }) => {
				captured = opts;
			},
			stop: async () => {},
			disconnect: async () => {},
		};
		(adapter as unknown as { connected: boolean }).connected = true;
		(adapter as unknown as { kafka: unknown }).kafka = { consumer: () => fakeConsumer };

		await adapter.process({ queue: "events", retries: 0, priority: 0 } as never, async () => {});

		expect(captured?.partitionsConsumedConcurrently).toBe(1);
	});
});

describe("RabbitMQAdapter — v0.7 PR 5", () => {
	it("reports provider 'rabbitmq'", () => {
		expect(new RabbitMQAdapter().provider).toBe("rabbitmq");
	});

	it("is not connected before connect()", () => {
		expect(new RabbitMQAdapter().isConnected()).toBe(false);
	});

	it("disconnect() before connect is a no-op", async () => {
		await expect(new RabbitMQAdapter().disconnect()).resolves.toBeUndefined();
	});

	it("reads AMQP_URL from env var", () => {
		process.env.AMQP_URL = "amqp://prod.example:5672";
		const adapter = new RabbitMQAdapter();
		expect((adapter as unknown as { config: { url: string } }).config.url).toBe("amqp://prod.example:5672");
		process.env.AMQP_URL = undefined;
	});
});

describe("SQSAdapter — v0.7 PR 5", () => {
	it("reports provider 'sqs'", () => {
		expect(new SQSAdapter().provider).toBe("sqs");
	});

	it("is not connected before connect()", () => {
		expect(new SQSAdapter().isConnected()).toBe(false);
	});

	it("disconnect() before connect is a no-op", async () => {
		await expect(new SQSAdapter().disconnect()).resolves.toBeUndefined();
	});

	it("honors the explicit region override", () => {
		const adapter = new SQSAdapter({ region: "eu-west-2" });
		expect((adapter as unknown as { config: { region: string } }).config.region).toBe("eu-west-2");
	});
});

describe("RedisStreamsAdapter — v0.7 PR 5", () => {
	it("reports provider 'redis'", () => {
		expect(new RedisStreamsAdapter().provider).toBe("redis");
	});

	it("is not connected before connect()", () => {
		expect(new RedisStreamsAdapter().isConnected()).toBe(false);
	});

	it("disconnect() before connect is a no-op", async () => {
		await expect(new RedisStreamsAdapter().disconnect()).resolves.toBeUndefined();
	});

	it("generates a unique consumer name per instance", () => {
		const a = new RedisStreamsAdapter();
		const b = new RedisStreamsAdapter();
		expect((a as unknown as { consumerName: string }).consumerName).not.toBe(
			(b as unknown as { consumerName: string }).consumerName,
		);
	});
});

describe("PgBossAdapter — v0.7 PR 5", () => {
	it("reports provider 'pg-boss'", () => {
		expect(new PgBossAdapter().provider).toBe("pg-boss");
	});

	it("is not connected before connect()", () => {
		expect(new PgBossAdapter().isConnected()).toBe(false);
	});

	it("disconnect() before connect is a no-op", async () => {
		await expect(new PgBossAdapter().disconnect()).resolves.toBeUndefined();
	});

	it("connect() throws a clear peer-dep error when pg-boss is absent", async () => {
		// pg-boss is the only adapter SDK NOT pre-installed in this monorepo,
		// so the lazy-import path actually throws here. The other adapters'
		// SDKs ARE installed (other workspaces use them) — their peer-dep
		// error paths get exercised in the docker-compose integration suite.
		const adapter = new PgBossAdapter();
		await expect(adapter.connect()).rejects.toThrow(/pg-boss/);
	});
});
