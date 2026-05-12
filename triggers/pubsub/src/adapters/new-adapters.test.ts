/**
 * Smoke tests for the v0.7 PR 6 pub/sub adapters (NATS, Redis
 * Streams, Kafka) plus the v0.7 publish() backfill on the existing
 * 3 (GCP, AWS, Azure). Boundary-only — constructor, provider name,
 * initial state, `disconnect()` before connect.
 *
 * Live broker round-trips need docker-compose CI (see PR 6 plan,
 * deferred to follow-up).
 */

import { describe, expect, it } from "vitest";

import { AWSSNSAdapter } from "./AWSSNSAdapter";
import { AzureServiceBusAdapter } from "./AzureServiceBusAdapter";
import { GCPPubSubAdapter } from "./GCPPubSubAdapter";
import { KafkaPubSubAdapter } from "./KafkaPubSubAdapter";
import { NATSPubSubAdapter } from "./NATSPubSubAdapter";
import { RedisStreamsPubSubAdapter } from "./RedisStreamsPubSubAdapter";

describe("NATSPubSubAdapter — v0.7 PR 6", () => {
	it("reports provider 'nats'", () => {
		expect(new NATSPubSubAdapter().provider).toBe("nats");
	});

	it("is not connected before connect()", () => {
		expect(new NATSPubSubAdapter().isConnected()).toBe(false);
	});

	it("disconnect() before connect is a no-op", async () => {
		await expect(new NATSPubSubAdapter().disconnect()).resolves.toBeUndefined();
	});

	it("reads server list from NATS_SERVERS env var", () => {
		process.env.NATS_SERVERS = "nats-a:4222,nats-b:4222";
		const adapter = new NATSPubSubAdapter();
		expect((adapter as unknown as { config: { servers: string[] } }).config.servers).toEqual([
			"nats-a:4222",
			"nats-b:4222",
		]);
		process.env.NATS_SERVERS = undefined;
	});
});

describe("RedisStreamsPubSubAdapter — v0.7 PR 6", () => {
	it("reports provider 'redis-streams'", () => {
		expect(new RedisStreamsPubSubAdapter().provider).toBe("redis-streams");
	});

	it("is not connected before connect()", () => {
		expect(new RedisStreamsPubSubAdapter().isConnected()).toBe(false);
	});

	it("disconnect() before connect is a no-op", async () => {
		await expect(new RedisStreamsPubSubAdapter().disconnect()).resolves.toBeUndefined();
	});

	it("generates a unique consumer name per instance (fan-out isolation)", () => {
		const a = new RedisStreamsPubSubAdapter();
		const b = new RedisStreamsPubSubAdapter();
		expect((a as unknown as { consumerName: string }).consumerName).not.toBe(
			(b as unknown as { consumerName: string }).consumerName,
		);
	});
});

describe("KafkaPubSubAdapter — v0.7 PR 6", () => {
	it("reports provider 'kafka'", () => {
		expect(new KafkaPubSubAdapter().provider).toBe("kafka");
	});

	it("is not connected before connect()", () => {
		expect(new KafkaPubSubAdapter().isConnected()).toBe(false);
	});

	it("disconnect() before connect is a no-op", async () => {
		await expect(new KafkaPubSubAdapter().disconnect()).resolves.toBeUndefined();
	});

	it("honors the explicit broker list override", () => {
		const adapter = new KafkaPubSubAdapter({ brokers: ["kafka-prod:9092"] });
		expect((adapter as unknown as { config: { brokers: string[] } }).config.brokers).toEqual(["kafka-prod:9092"]);
	});
});

describe("Existing adapters — provider names + publish() surface (v0.7 PR 6 backfill)", () => {
	it("GCPPubSubAdapter reports provider 'gcp'", () => {
		expect(new GCPPubSubAdapter().provider).toBe("gcp");
	});

	it("AWSSNSAdapter reports provider 'aws'", () => {
		expect(new AWSSNSAdapter().provider).toBe("aws");
	});

	it("AzureServiceBusAdapter reports provider 'azure'", () => {
		const adapter = new AzureServiceBusAdapter({
			connectionString: "Endpoint=sb://example.servicebus.windows.net/;...",
		});
		expect(adapter.provider).toBe("azure");
	});

	it("all three now expose a publish() method (added in PR 6)", () => {
		expect(typeof new GCPPubSubAdapter().publish).toBe("function");
		expect(typeof new AWSSNSAdapter().publish).toBe("function");
		expect(
			typeof new AzureServiceBusAdapter({ connectionString: "Endpoint=sb://x.servicebus.windows.net/;Y" }).publish,
		).toBe("function");
	});
});
