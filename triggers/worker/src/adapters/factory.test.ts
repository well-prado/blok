/**
 * Adapter factory unit tests — v0.7 PR 5.
 *
 * Covers provider resolution order, the constructor lookup table,
 * pool sharing, and the test-reset utility.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetAdapterPoolForTests, createWorkerAdapter, getOrCreateAdapter, resolveProvider } from "./factory";

describe("adapter factory — v0.7 PR 5", () => {
	beforeEach(() => {
		_resetAdapterPoolForTests();
		process.env.BLOK_WORKER_ADAPTER = undefined;
	});

	afterEach(() => {
		_resetAdapterPoolForTests();
		process.env.BLOK_WORKER_ADAPTER = undefined;
	});

	describe("resolveProvider()", () => {
		it("returns the explicit provider when set", () => {
			expect(resolveProvider("kafka")).toBe("kafka");
		});

		it("falls back to BLOK_WORKER_ADAPTER env var", () => {
			process.env.BLOK_WORKER_ADAPTER = "rabbitmq";
			expect(resolveProvider(undefined)).toBe("rabbitmq");
		});

		it("falls back to in-memory when neither is set", () => {
			expect(resolveProvider(undefined)).toBe("in-memory");
		});

		it("ignores invalid env values and falls back to in-memory", () => {
			process.env.BLOK_WORKER_ADAPTER = "not-a-provider";
			expect(resolveProvider(undefined)).toBe("in-memory");
		});

		it("explicit provider wins over the env var", () => {
			process.env.BLOK_WORKER_ADAPTER = "bullmq";
			expect(resolveProvider("kafka")).toBe("kafka");
		});
	});

	describe("createWorkerAdapter()", () => {
		it("returns the correct provider name for each built-in", () => {
			expect(createWorkerAdapter("in-memory").provider).toBe("in-memory");
			expect(createWorkerAdapter("nats").provider).toBe("nats");
			expect(createWorkerAdapter("bullmq").provider).toBe("bullmq");
			expect(createWorkerAdapter("kafka").provider).toBe("kafka");
			expect(createWorkerAdapter("rabbitmq").provider).toBe("rabbitmq");
			expect(createWorkerAdapter("sqs").provider).toBe("sqs");
			expect(createWorkerAdapter("redis").provider).toBe("redis");
			expect(createWorkerAdapter("pg-boss").provider).toBe("pg-boss");
		});

		it("each call returns a fresh instance", () => {
			const a = createWorkerAdapter("in-memory");
			const b = createWorkerAdapter("in-memory");
			expect(a).not.toBe(b);
		});
	});

	describe("getOrCreateAdapter()", () => {
		it("returns the same instance on repeated calls for the same provider", () => {
			const a = getOrCreateAdapter("in-memory");
			const b = getOrCreateAdapter("in-memory");
			expect(a).toBe(b);
		});

		it("returns different instances for different providers", () => {
			const inMem = getOrCreateAdapter("in-memory");
			const kafka = getOrCreateAdapter("kafka");
			expect(inMem).not.toBe(kafka);
			expect(inMem.provider).toBe("in-memory");
			expect(kafka.provider).toBe("kafka");
		});

		it("_resetAdapterPoolForTests() drops cached instances", () => {
			const first = getOrCreateAdapter("in-memory");
			_resetAdapterPoolForTests();
			const second = getOrCreateAdapter("in-memory");
			expect(first).not.toBe(second);
		});
	});
});
