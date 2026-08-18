// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimePeriod } from "./filterTypes";
import { formatTimePeriod, parsePeriodString, periodToDateRange, toDateTimeLocalString } from "./timePeriod";

describe("timePeriod", () => {
	describe("parsePeriodString", () => {
		it("parses valid relative strings", () => {
			expect(parsePeriodString("1m")).toEqual({ type: "relative", value: "1m" });
			expect(parsePeriodString("5h")).toEqual({ type: "relative", value: "5h" });
			expect(parsePeriodString("30d")).toEqual({ type: "relative", value: "30d" });
			expect(parsePeriodString(" 1d ")).toEqual({ type: "relative", value: "1d" });
			expect(parsePeriodString("2M")).toEqual({ type: "relative", value: "2m" });
		});

		it("returns null for invalid strings", () => {
			expect(parsePeriodString("")).toBeNull();
			expect(parsePeriodString("1x")).toBeNull();
			expect(parsePeriodString("m")).toBeNull();
			expect(parsePeriodString("-1m")).toBeNull();
			expect(parsePeriodString("0m")).toBeNull();
		});
	});

	describe("periodToDateRange", () => {
		const MOCK_TIME = new Date("2026-08-18T12:00:00Z");

		it("handles absolute periods", () => {
			const period: TimePeriod = { type: "absolute", from: 1700000000000, to: 1700003600000 };
			const range = periodToDateRange(period, MOCK_TIME);
			expect(range.from.getTime()).toBe(1700000000000);
			expect(range.to.getTime()).toBe(1700003600000);
		});

		it("handles relative periods correctly", () => {
			const m1 = periodToDateRange({ type: "relative", value: "1m" }, MOCK_TIME);
			expect(m1.from.getTime()).toBe(MOCK_TIME.getTime() - 60 * 1000);
			expect(m1.to.getTime()).toBe(MOCK_TIME.getTime());

			const h5 = periodToDateRange({ type: "relative", value: "5h" }, MOCK_TIME);
			expect(h5.from.getTime()).toBe(MOCK_TIME.getTime() - 5 * 60 * 60 * 1000);

			const d3 = periodToDateRange({ type: "relative", value: "3d" }, MOCK_TIME);
			expect(d3.from.getTime()).toBe(MOCK_TIME.getTime() - 3 * 24 * 60 * 60 * 1000);
		});
	});

	describe("formatTimePeriod", () => {
		it("formats relative periods", () => {
			expect(formatTimePeriod({ type: "relative", value: "5m" })).toBe("Last 5m");
			expect(formatTimePeriod({ type: "relative", value: "1d" })).toBe("Last 1d");
		});

		it("formats absolute periods", () => {
			const period: TimePeriod = { type: "absolute", from: 1700000000000, to: 1700003600000 };
			const formatted = formatTimePeriod(period);
			expect(formatted).toContain(new Date(1700000000000).toLocaleString());
			expect(formatted).toContain(new Date(1700003600000).toLocaleString());
		});
	});

	describe("toDateTimeLocalString", () => {
		it("formats correctly", () => {
			const d = new Date(2026, 7, 18, 14, 5); // Month is 0-indexed (7 = Aug)
			expect(toDateTimeLocalString(d)).toBe("2026-08-18T14:05");
		});
	});
});
