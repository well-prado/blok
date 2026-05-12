/**
 * Pub/Sub adapter factory unit tests — v0.7 PR 6.
 *
 * Mirrors the worker factory tests (PR 5) — provider resolution
 * order, constructor lookup, pool sharing, reset utility.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetAdapterPoolForTests, createPubSubAdapter, getOrCreateAdapter, resolveProvider } from "./factory";

describe("pubsub adapter factory — v0.7 PR 6", () => {
	beforeEach(() => {
		_resetAdapterPoolForTests();
		process.env.BLOK_PUBSUB_ADAPTER = undefined;
	});

	afterEach(() => {
		_resetAdapterPoolForTests();
		process.env.BLOK_PUBSUB_ADAPTER = undefined;
	});

	describe("resolveProvider()", () => {
		it("returns the explicit provider when set", () => {
			expect(resolveProvider("kafka")).toBe("kafka");
		});

		it("falls back to BLOK_PUBSUB_ADAPTER env var", () => {
			process.env.BLOK_PUBSUB_ADAPTER = "redis-streams";
			expect(resolveProvider(undefined)).toBe("redis-streams");
		});

		it("falls back to nats when neither is set", () => {
			expect(resolveProvider(undefined)).toBe("nats");
		});

		it("ignores invalid env values and falls back to nats", () => {
			process.env.BLOK_PUBSUB_ADAPTER = "not-a-provider";
			expect(resolveProvider(undefined)).toBe("nats");
		});

		it("explicit provider wins over the env var", () => {
			process.env.BLOK_PUBSUB_ADAPTER = "gcp";
			expect(resolveProvider("aws")).toBe("aws");
		});
	});

	describe("createPubSubAdapter()", () => {
		it("returns the correct provider name for each built-in", () => {
			expect(createPubSubAdapter("nats").provider).toBe("nats");
			expect(createPubSubAdapter("redis-streams").provider).toBe("redis-streams");
			expect(createPubSubAdapter("kafka").provider).toBe("kafka");
			expect(createPubSubAdapter("gcp").provider).toBe("gcp");
			expect(createPubSubAdapter("aws").provider).toBe("aws");
			expect(createPubSubAdapter("azure").provider).toBe("azure");
		});

		it("each call returns a fresh instance", () => {
			const a = createPubSubAdapter("nats");
			const b = createPubSubAdapter("nats");
			expect(a).not.toBe(b);
		});
	});

	describe("getOrCreateAdapter()", () => {
		it("returns the same instance on repeated calls for the same provider", () => {
			const a = getOrCreateAdapter("nats");
			const b = getOrCreateAdapter("nats");
			expect(a).toBe(b);
		});

		it("returns different instances for different providers", () => {
			const nats = getOrCreateAdapter("nats");
			const kafka = getOrCreateAdapter("kafka");
			expect(nats).not.toBe(kafka);
			expect(nats.provider).toBe("nats");
			expect(kafka.provider).toBe("kafka");
		});

		it("_resetAdapterPoolForTests() drops cached instances", () => {
			const first = getOrCreateAdapter("nats");
			_resetAdapterPoolForTests();
			const second = getOrCreateAdapter("nats");
			expect(first).not.toBe(second);
		});
	});
});
