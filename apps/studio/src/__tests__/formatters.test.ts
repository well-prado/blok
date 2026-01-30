import { formatBytes, formatDuration, formatPercent, formatRelativeTime, truncate } from "@/lib/formatters";
import { describe, expect, it } from "vitest";

describe("formatDuration", () => {
	it("returns dash for undefined", () => {
		expect(formatDuration(undefined)).toBe("—");
	});

	it("returns <1ms for sub-millisecond", () => {
		expect(formatDuration(0.5)).toBe("<1ms");
	});

	it("formats milliseconds", () => {
		expect(formatDuration(42)).toBe("42ms");
		expect(formatDuration(999)).toBe("999ms");
	});

	it("formats seconds", () => {
		expect(formatDuration(1500)).toBe("1.5s");
		expect(formatDuration(59999)).toBe("60.0s");
	});

	it("formats minutes and seconds", () => {
		expect(formatDuration(60000)).toBe("1m 0s");
		expect(formatDuration(90000)).toBe("1m 30s");
		expect(formatDuration(125000)).toBe("2m 5s");
	});

	it("rounds milliseconds", () => {
		expect(formatDuration(42.7)).toBe("43ms");
	});
});

describe("formatBytes", () => {
	it("returns dash for undefined", () => {
		expect(formatBytes(undefined)).toBe("—");
	});

	it("formats bytes", () => {
		expect(formatBytes(512)).toBe("512B");
	});

	it("formats kilobytes", () => {
		expect(formatBytes(1024)).toBe("1.0KB");
		expect(formatBytes(1536)).toBe("1.5KB");
	});

	it("formats megabytes", () => {
		expect(formatBytes(1048576)).toBe("1.0MB");
		expect(formatBytes(5242880)).toBe("5.0MB");
	});

	it("formats gigabytes", () => {
		expect(formatBytes(1073741824)).toBe("1.0GB");
	});
});

describe("formatRelativeTime", () => {
	it("returns 'just now' for very recent", () => {
		expect(formatRelativeTime(Date.now())).toBe("just now");
	});

	it("formats seconds ago", () => {
		expect(formatRelativeTime(Date.now() - 5000)).toBe("5s ago");
	});

	it("formats minutes ago", () => {
		expect(formatRelativeTime(Date.now() - 120000)).toBe("2m ago");
	});

	it("formats hours ago", () => {
		expect(formatRelativeTime(Date.now() - 7200000)).toBe("2h ago");
	});

	it("formats days ago", () => {
		expect(formatRelativeTime(Date.now() - 172800000)).toBe("2d ago");
	});
});

describe("formatPercent", () => {
	it("formats zero", () => {
		expect(formatPercent(0)).toBe("0%");
	});

	it("formats small values", () => {
		expect(formatPercent(0.005)).toBe("<1%");
	});

	it("formats normal values", () => {
		expect(formatPercent(0.052)).toBe("5.2%");
		expect(formatPercent(0.5)).toBe("50.0%");
		expect(formatPercent(1)).toBe("100.0%");
	});
});

describe("truncate", () => {
	it("returns string as-is when within limit", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("truncates long strings with ellipsis", () => {
		expect(truncate("hello world", 6)).toBe("hello\u2026");
	});

	it("handles exact length", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});
});
