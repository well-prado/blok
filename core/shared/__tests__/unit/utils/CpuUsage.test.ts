import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CpuMetrics from "../../../src/utils/CpuUsage";

const mockCpuInfo = (idle: number, user: number, sys: number) => [
	{
		model: "Test CPU Model",
		speed: 2400,
		times: { idle, user, sys, nice: 0, irq: 0 },
	},
	{
		model: "Test CPU Model",
		speed: 2400,
		times: { idle, user, sys, nice: 0, irq: 0 },
	},
];

describe("CpuMetrics", () => {
	let cpu: CpuMetrics;

	beforeEach(() => {
		cpu = new CpuMetrics();
		vi.restoreAllMocks();
	});

	describe("start()", () => {
		it("should capture CPU info (model and count)", () => {
			vi.spyOn(os, "cpus").mockReturnValue(mockCpuInfo(1000, 500, 200) as os.CpuInfo[]);
			cpu.start();
			const metrics = cpu.getMetrics();
			expect(metrics.model).toBe("Test CPU Model");
			expect(metrics.total).toBe(2);
		});
	});

	describe("stop()", () => {
		it("should capture end usage without error", () => {
			vi.spyOn(os, "cpus").mockReturnValue(mockCpuInfo(1000, 500, 200) as os.CpuInfo[]);
			cpu.start();
			cpu.stop();
			// Should not throw
			expect(true).toBe(true);
		});
	});

	describe("getAverage()", () => {
		it("should calculate CPU percentage between start and stop", () => {
			const startCpus = mockCpuInfo(1000, 500, 200);
			const stopCpus = mockCpuInfo(1050, 550, 250);

			vi.spyOn(os, "cpus")
				.mockReturnValueOnce(startCpus as os.CpuInfo[]) // start -> constructor call
				.mockReturnValueOnce(startCpus as os.CpuInfo[]) // start -> measureCpu
				.mockReturnValueOnce(stopCpus as os.CpuInfo[]) // stop -> measureCpu
				.mockReturnValueOnce(stopCpus as os.CpuInfo[]); // potential extra

			cpu.start();
			cpu.stop();

			const metrics = cpu.getMetrics();
			expect(metrics.average).toBeTypeOf("number");
			expect(metrics.average).toBeGreaterThanOrEqual(0);
			expect(metrics.average).toBeLessThanOrEqual(100);
		});
	});

	describe("getMetrics()", () => {
		it("should return correct shape with total, average, usage, model", () => {
			vi.spyOn(os, "cpus").mockReturnValue(mockCpuInfo(1000, 500, 200) as os.CpuInfo[]);
			cpu.start();
			cpu.stop();

			const metrics = cpu.getMetrics();
			expect(metrics).toHaveProperty("total");
			expect(metrics).toHaveProperty("average");
			expect(metrics).toHaveProperty("usage");
			expect(metrics).toHaveProperty("model");
		});
	});

	describe("measureCpu()", () => {
		it("should return idle, total, model, cpus shape", () => {
			vi.spyOn(os, "cpus").mockReturnValue(mockCpuInfo(1000, 500, 200) as os.CpuInfo[]);
			const result = cpu.measureCpu();
			expect(result).toHaveProperty("idle");
			expect(result).toHaveProperty("total");
			expect(result).toHaveProperty("model");
			expect(result).toHaveProperty("cpus");
			expect(result.cpus).toBe(2);
		});

		it("should aggregate across all CPU cores", () => {
			vi.spyOn(os, "cpus").mockReturnValue(mockCpuInfo(1000, 500, 200) as os.CpuInfo[]);
			const result = cpu.measureCpu();
			// idle is averaged: (1000 + 1000) / 2 = 1000
			expect(result.idle).toBe(1000);
			// total per core: idle + irq + nice + sys + user = 1000 + 0 + 0 + 200 + 500 = 1700
			// averaged: (1700 + 1700) / 2 = 1700
			expect(result.total).toBe(1700);
		});
	});
});
