import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NatsKvConcurrencyBackend } from "../../../src/concurrency/NatsKvConcurrencyBackend";
import { createConcurrencyBackend } from "../../../src/concurrency/createConcurrencyBackend";

describe("createConcurrencyBackend (Tier 2 #6 follow-up)", () => {
	beforeEach(() => {
		// Stub to "" — the factory treats empty string the same as unset.
		vi.stubEnv("BLOK_CONCURRENCY_BACKEND", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns null when BLOK_CONCURRENCY_BACKEND is empty (unset)", () => {
		expect(createConcurrencyBackend()).toBeNull();
	});

	it("returns null when BLOK_CONCURRENCY_BACKEND is 'memory'", () => {
		vi.stubEnv("BLOK_CONCURRENCY_BACKEND", "memory");
		expect(createConcurrencyBackend()).toBeNull();
	});

	it("returns null when BLOK_CONCURRENCY_BACKEND is 'in-process'", () => {
		vi.stubEnv("BLOK_CONCURRENCY_BACKEND", "in-process");
		expect(createConcurrencyBackend()).toBeNull();
	});

	it("returns a NatsKvConcurrencyBackend instance for 'nats-kv'", () => {
		vi.stubEnv("BLOK_CONCURRENCY_BACKEND", "nats-kv");
		const backend = createConcurrencyBackend();
		expect(backend).toBeInstanceOf(NatsKvConcurrencyBackend);
		expect(backend?.name).toBe("nats-kv");
	});

	it("treats whitespace + casing the same way", () => {
		vi.stubEnv("BLOK_CONCURRENCY_BACKEND", "  NATS-KV  ");
		const backend = createConcurrencyBackend();
		expect(backend).toBeInstanceOf(NatsKvConcurrencyBackend);
	});

	it("throws on unknown backend kind with a helpful error", () => {
		vi.stubEnv("BLOK_CONCURRENCY_BACKEND", "redis");
		expect(() => createConcurrencyBackend()).toThrow(/Unknown BLOK_CONCURRENCY_BACKEND='redis'/);
	});
});
