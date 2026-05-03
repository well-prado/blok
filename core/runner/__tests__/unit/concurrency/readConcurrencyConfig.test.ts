import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONCURRENCY_DEFAULTS, readConcurrencyConfig } from "../../../src/concurrency/readConcurrencyConfig";

describe("readConcurrencyConfig", () => {
	const ORIGINAL_LEASE_ENV = process.env.BLOK_CONCURRENCY_LEASE_MS;

	beforeEach(() => {
		process.env.BLOK_CONCURRENCY_LEASE_MS = undefined;
	});

	afterEach(() => {
		if (ORIGINAL_LEASE_ENV === undefined) {
			process.env.BLOK_CONCURRENCY_LEASE_MS = undefined;
		} else {
			process.env.BLOK_CONCURRENCY_LEASE_MS = ORIGINAL_LEASE_ENV;
		}
	});

	it("returns null when trigger is undefined or null", () => {
		expect(readConcurrencyConfig(undefined)).toBeNull();
		expect(readConcurrencyConfig(null)).toBeNull();
	});

	it("returns null when trigger has no http or worker block", () => {
		expect(readConcurrencyConfig({ cron: { schedule: "* * * * *" } })).toBeNull();
	});

	it("returns null when http exists but has no concurrencyKey", () => {
		expect(readConcurrencyConfig({ http: { method: "POST", path: "/api" } })).toBeNull();
	});

	it("returns null when concurrencyKey is empty string", () => {
		expect(readConcurrencyConfig({ http: { method: "POST", concurrencyKey: "" } })).toBeNull();
	});

	it("reads concurrencyKey + concurrencyLimit from http trigger", () => {
		const cfg = readConcurrencyConfig({
			http: { method: "POST", concurrencyKey: "tenant-x", concurrencyLimit: 5 },
		});
		expect(cfg).toEqual({
			keyExpression: "tenant-x",
			limit: 5,
			leaseMs: CONCURRENCY_DEFAULTS.leaseMs,
		});
	});

	it("defaults limit to 1 (Trigger.dev parity) when only the key is set", () => {
		const cfg = readConcurrencyConfig({
			http: { method: "POST", concurrencyKey: "tenant-x" },
		});
		expect(cfg?.limit).toBe(1);
	});

	it("reads concurrencyKey + concurrencyLimit from worker trigger", () => {
		const cfg = readConcurrencyConfig({
			worker: { queue: "renders", concurrency: 10, concurrencyKey: "$.req.body.tenantId", concurrencyLimit: 2 },
		});
		expect(cfg).toEqual({
			keyExpression: "$.req.body.tenantId",
			limit: 2,
			leaseMs: CONCURRENCY_DEFAULTS.leaseMs,
		});
	});

	it("prefers http over worker when both blocks declare a concurrencyKey", () => {
		const cfg = readConcurrencyConfig({
			http: { method: "POST", concurrencyKey: "from-http" },
			worker: { queue: "q", concurrencyKey: "from-worker" },
		});
		expect(cfg?.keyExpression).toBe("from-http");
	});

	it("falls through to worker when http has no concurrencyKey", () => {
		const cfg = readConcurrencyConfig({
			http: { method: "POST" },
			worker: { queue: "q", concurrencyKey: "from-worker" },
		});
		expect(cfg?.keyExpression).toBe("from-worker");
	});

	it("respects per-trigger concurrencyLeaseMs over the env override", () => {
		process.env.BLOK_CONCURRENCY_LEASE_MS = "60000";
		const cfg = readConcurrencyConfig({
			http: { method: "POST", concurrencyKey: "x", concurrencyLeaseMs: 5000 },
		});
		expect(cfg?.leaseMs).toBe(5000);
	});

	it("respects BLOK_CONCURRENCY_LEASE_MS env when no per-trigger value", () => {
		process.env.BLOK_CONCURRENCY_LEASE_MS = "60000";
		const cfg = readConcurrencyConfig({
			http: { method: "POST", concurrencyKey: "x" },
		});
		expect(cfg?.leaseMs).toBe(60000);
	});

	it("ignores BLOK_CONCURRENCY_LEASE_MS env when not numeric", () => {
		process.env.BLOK_CONCURRENCY_LEASE_MS = "not-a-number";
		const cfg = readConcurrencyConfig({
			http: { method: "POST", concurrencyKey: "x" },
		});
		expect(cfg?.leaseMs).toBe(CONCURRENCY_DEFAULTS.leaseMs);
	});

	it("trims whitespace around keyExpression", () => {
		const cfg = readConcurrencyConfig({
			http: { method: "POST", concurrencyKey: "  tenant-x  " },
		});
		expect(cfg?.keyExpression).toBe("tenant-x");
	});
});
