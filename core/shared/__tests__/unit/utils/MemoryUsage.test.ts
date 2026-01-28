import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MemoryUsage from "../../../src/utils/MemoryUsage";

describe("MemoryUsage", () => {
	let memory: MemoryUsage;

	beforeEach(() => {
		memory = new MemoryUsage();
		vi.restoreAllMocks();
	});

	describe("start()", () => {
		it("should increment counter", () => {
			vi.spyOn(process, "memoryUsage").mockReturnValue({
				heapUsed: 50_000_000,
				heapTotal: 100_000_000,
				rss: 200_000_000,
				external: 10_000_000,
				arrayBuffers: 5_000_000,
			});

			memory.start();
			memory.start();

			const metrics = memory.getMetrics();
			// total is average = total_val / counter, with 2 starts
			expect(metrics.total).toBeTypeOf("number");
		});

		it("should track min value", () => {
			vi.spyOn(process, "memoryUsage")
				.mockReturnValueOnce({ heapUsed: 100_000_000, heapTotal: 0, rss: 0, external: 0, arrayBuffers: 0 })
				.mockReturnValueOnce({ heapUsed: 50_000_000, heapTotal: 0, rss: 0, external: 0, arrayBuffers: 0 });

			memory.start();
			memory.start();

			const metrics = memory.getMetrics();
			expect(metrics.min).toBe(50); // 50_000_000 / 1_000_000
		});

		it("should track max value", () => {
			vi.spyOn(process, "memoryUsage")
				.mockReturnValueOnce({ heapUsed: 50_000_000, heapTotal: 0, rss: 0, external: 0, arrayBuffers: 0 })
				.mockReturnValueOnce({ heapUsed: 100_000_000, heapTotal: 0, rss: 0, external: 0, arrayBuffers: 0 });

			memory.start();
			memory.start();

			const metrics = memory.getMetrics();
			expect(metrics.max).toBe(100); // 100_000_000 / 1_000_000
		});

		it("should set min_val on first call", () => {
			vi.spyOn(process, "memoryUsage").mockReturnValue({
				heapUsed: 75_000_000,
				heapTotal: 0,
				rss: 0,
				external: 0,
				arrayBuffers: 0,
			});

			memory.start();

			const metrics = memory.getMetrics();
			expect(metrics.min).toBe(75);
		});
	});

	describe("stop()", () => {
		it("should be a no-op", () => {
			memory.stop();
			// Should not throw or change state
			const metrics = memory.getMetrics();
			expect(metrics.total).toBeNaN(); // 0 / 0
		});
	});

	describe("getMetrics()", () => {
		it("should return average, min, max, global_memory, global_free_memory", () => {
			vi.spyOn(process, "memoryUsage").mockReturnValue({
				heapUsed: 50_000_000,
				heapTotal: 0,
				rss: 0,
				external: 0,
				arrayBuffers: 0,
			});
			vi.spyOn(os, "totalmem").mockReturnValue(16_000_000_000);
			vi.spyOn(os, "freemem").mockReturnValue(8_000_000_000);

			memory.start();

			const metrics = memory.getMetrics();
			expect(metrics).toHaveProperty("total");
			expect(metrics).toHaveProperty("min");
			expect(metrics).toHaveProperty("max");
			expect(metrics.global_memory).toBe(16000);
			expect(metrics.global_free_memory).toBe(8000);
		});
	});

	describe("clear()", () => {
		it("should reset all values to 0", () => {
			vi.spyOn(process, "memoryUsage").mockReturnValue({
				heapUsed: 50_000_000,
				heapTotal: 0,
				rss: 0,
				external: 0,
				arrayBuffers: 0,
			});

			memory.start();
			memory.clear();

			const metrics = memory.getMetrics();
			expect(metrics.min).toBe(0);
			expect(metrics.max).toBe(0);
		});
	});
});
