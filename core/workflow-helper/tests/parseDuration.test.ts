import { describe, expect, it } from "vitest";
import { parseDuration, tryParseDuration } from "../src/utils/parseDuration";

describe("parseDuration", () => {
	describe("number inputs", () => {
		it("accepts non-negative integers as milliseconds", () => {
			expect(parseDuration(0)).toBe(0);
			expect(parseDuration(1)).toBe(1);
			expect(parseDuration(5000)).toBe(5000);
			expect(parseDuration(60_000)).toBe(60_000);
		});

		it("floors fractional milliseconds", () => {
			expect(parseDuration(1.7)).toBe(1);
			expect(parseDuration(999.99)).toBe(999);
		});

		it("rejects negative numbers", () => {
			expect(() => parseDuration(-1)).toThrow(/must be >= 0/);
			expect(() => parseDuration(-1000)).toThrow(/must be >= 0/);
		});

		it("rejects NaN and Infinity", () => {
			expect(() => parseDuration(Number.NaN)).toThrow(/finite number/);
			expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(/finite number/);
			expect(() => parseDuration(Number.NEGATIVE_INFINITY)).toThrow(/finite number/);
		});
	});

	describe("string inputs", () => {
		it('parses "Nms" as milliseconds', () => {
			expect(parseDuration("0ms")).toBe(0);
			expect(parseDuration("500ms")).toBe(500);
			expect(parseDuration("12345ms")).toBe(12345);
		});

		it('parses "Ns" as seconds', () => {
			expect(parseDuration("1s")).toBe(1000);
			expect(parseDuration("30s")).toBe(30_000);
		});

		it('parses "Nm" as minutes', () => {
			expect(parseDuration("1m")).toBe(60_000);
			expect(parseDuration("5m")).toBe(300_000);
		});

		it('parses "Nh" as hours', () => {
			expect(parseDuration("1h")).toBe(3_600_000);
			expect(parseDuration("24h")).toBe(86_400_000);
		});

		it('parses "Nd" as days', () => {
			expect(parseDuration("1d")).toBe(86_400_000);
			expect(parseDuration("7d")).toBe(7 * 86_400_000);
		});

		it("trims surrounding whitespace", () => {
			expect(parseDuration("  500ms  ")).toBe(500);
			expect(parseDuration("\t1h\n")).toBe(3_600_000);
		});

		it("rejects empty / whitespace-only strings", () => {
			expect(() => parseDuration("")).toThrow(/empty string/);
			expect(() => parseDuration("   ")).toThrow(/empty string/);
		});

		it("rejects multi-unit strings", () => {
			expect(() => parseDuration("1h30m")).toThrow(/Invalid duration/);
			expect(() => parseDuration("2d3h")).toThrow(/Invalid duration/);
		});

		it("rejects fractional values", () => {
			expect(() => parseDuration("1.5h")).toThrow(/Invalid duration/);
			expect(() => parseDuration("0.5m")).toThrow(/Invalid duration/);
		});

		it("rejects negative strings", () => {
			expect(() => parseDuration("-5s")).toThrow(/Invalid duration/);
		});

		it("rejects unknown units", () => {
			expect(() => parseDuration("5y")).toThrow(/Invalid duration/);
			expect(() => parseDuration("5w")).toThrow(/Invalid duration/);
			expect(() => parseDuration("5min")).toThrow(/Invalid duration/);
			expect(() => parseDuration("5sec")).toThrow(/Invalid duration/);
		});

		it("rejects bare integers as strings", () => {
			expect(() => parseDuration("500")).toThrow(/Invalid duration/);
		});

		it("rejects unit-only strings", () => {
			expect(() => parseDuration("ms")).toThrow(/Invalid duration/);
			expect(() => parseDuration("h")).toThrow(/Invalid duration/);
		});
	});

	describe("non-string non-number inputs", () => {
		it("rejects null / undefined / objects", () => {
			expect(() => parseDuration(null as unknown as number)).toThrow(/must be a number or string/);
			expect(() => parseDuration(undefined as unknown as number)).toThrow(/must be a number or string/);
			expect(() => parseDuration({} as unknown as number)).toThrow(/must be a number or string/);
			expect(() => parseDuration(true as unknown as number)).toThrow(/must be a number or string/);
		});
	});
});

describe("tryParseDuration", () => {
	it("returns the parsed value on valid input", () => {
		expect(tryParseDuration("1h")).toBe(3_600_000);
		expect(tryParseDuration(5000)).toBe(5000);
	});

	it("returns null on invalid input instead of throwing", () => {
		expect(tryParseDuration("garbage")).toBeNull();
		expect(tryParseDuration(-5)).toBeNull();
		expect(tryParseDuration(null)).toBeNull();
		expect(tryParseDuration({})).toBeNull();
		expect(tryParseDuration("")).toBeNull();
	});
});
