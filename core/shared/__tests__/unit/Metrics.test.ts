import { beforeEach, describe, expect, it } from "vitest";
import { Metrics } from "../../src/Metrics";

describe("Metrics", () => {
	let metrics: Metrics;

	beforeEach(() => {
		metrics = new Metrics();
	});

	it("should construct without errors", () => {
		expect(metrics).toBeDefined();
	});

	describe("start()", () => {
		it("should call start on all sub-metrics without error", () => {
			expect(() => metrics.start()).not.toThrow();
		});
	});

	describe("stop()", () => {
		it("should call stop without error after start", () => {
			metrics.start();
			expect(() => metrics.stop()).not.toThrow();
		});
	});

	describe("retry()", () => {
		it("should call start on memoryUsage only", () => {
			metrics.start();
			expect(() => metrics.retry()).not.toThrow();
		});
	});

	describe("clear()", () => {
		it("should clear memory usage values", () => {
			metrics.start();
			metrics.clear();
			// After clear, memory metrics should be zeroed
			const result = metrics.getMetrics();
			expect(result.memory.min).toBe(0);
			expect(result.memory.max).toBe(0);
		});
	});

	describe("getMetrics()", () => {
		it("should return object with cpu, memory, time", () => {
			metrics.start();
			metrics.stop();

			const result = metrics.getMetrics();
			expect(result).toHaveProperty("cpu");
			expect(result).toHaveProperty("memory");
			expect(result).toHaveProperty("time");
		});

		it("should return valid metric shapes after start/stop cycle", () => {
			metrics.start();
			metrics.stop();

			const result = metrics.getMetrics();
			// CPU
			expect(result.cpu).toHaveProperty("total");
			expect(result.cpu).toHaveProperty("average");
			expect(result.cpu).toHaveProperty("usage");
			expect(result.cpu).toHaveProperty("model");
			// Memory
			expect(result.memory).toHaveProperty("total");
			expect(result.memory).toHaveProperty("min");
			expect(result.memory).toHaveProperty("max");
			// Time
			expect(result.time).toHaveProperty("startTime");
			expect(result.time).toHaveProperty("endTime");
			expect(result.time).toHaveProperty("duration");
		});
	});
});
