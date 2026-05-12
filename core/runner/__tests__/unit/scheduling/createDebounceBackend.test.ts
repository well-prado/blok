import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NatsKvDebounceBackend } from "../../../src/scheduling/NatsKvDebounceBackend";
import { RedisDebounceBackend } from "../../../src/scheduling/RedisDebounceBackend";
import { createDebounceBackend } from "../../../src/scheduling/createDebounceBackend";

describe("createDebounceBackend (Tier C #1)", () => {
	beforeEach(() => {
		vi.stubEnv("BLOK_DEBOUNCE_BACKEND", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns null when BLOK_DEBOUNCE_BACKEND is empty (unset)", () => {
		expect(createDebounceBackend()).toBeNull();
	});

	it("returns null when BLOK_DEBOUNCE_BACKEND is 'memory'", () => {
		vi.stubEnv("BLOK_DEBOUNCE_BACKEND", "memory");
		expect(createDebounceBackend()).toBeNull();
	});

	it("returns null when BLOK_DEBOUNCE_BACKEND is 'in-process'", () => {
		vi.stubEnv("BLOK_DEBOUNCE_BACKEND", "in-process");
		expect(createDebounceBackend()).toBeNull();
	});

	it("returns a NatsKvDebounceBackend instance for 'nats-kv'", () => {
		vi.stubEnv("BLOK_DEBOUNCE_BACKEND", "nats-kv");
		const backend = createDebounceBackend();
		expect(backend).toBeInstanceOf(NatsKvDebounceBackend);
		expect(backend?.name).toBe("nats-kv");
	});

	it("returns a RedisDebounceBackend instance for 'redis'", () => {
		vi.stubEnv("BLOK_DEBOUNCE_BACKEND", "redis");
		const backend = createDebounceBackend();
		expect(backend).toBeInstanceOf(RedisDebounceBackend);
		expect(backend?.name).toBe("redis");
	});

	it("normalizes whitespace + casing", () => {
		vi.stubEnv("BLOK_DEBOUNCE_BACKEND", "  REDIS  ");
		const backend = createDebounceBackend();
		expect(backend).toBeInstanceOf(RedisDebounceBackend);
	});

	it("throws on unknown backend kind with a helpful error", () => {
		vi.stubEnv("BLOK_DEBOUNCE_BACKEND", "dynamodb");
		expect(() => createDebounceBackend()).toThrow(/Unknown BLOK_DEBOUNCE_BACKEND='dynamodb'/);
		expect(() => createDebounceBackend()).toThrow(/nats-kv/);
		expect(() => createDebounceBackend()).toThrow(/redis/);
	});
});
