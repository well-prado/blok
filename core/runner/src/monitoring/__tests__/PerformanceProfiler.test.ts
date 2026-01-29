import { beforeEach, describe, expect, it } from "vitest";
import { PerformanceProfiler } from "../PerformanceProfiler";

describe("PerformanceProfiler", () => {
	let profiler: PerformanceProfiler;

	beforeEach(() => {
		profiler = new PerformanceProfiler();
	});

	describe("Basic Functionality", () => {
		it("should return empty profiles when no samples added", () => {
			expect(profiler.getProfiles()).toEqual([]);
		});

		it("should accept a single sample", () => {
			profiler.addSample("wf", "node1", 10);
			const profiles = profiler.getProfiles();
			expect(profiles.length).toBe(1);
			expect(profiles[0].nodes.length).toBe(1);
		});

		it("should reset all data", () => {
			profiler.addSample("wf", "node1", 10);
			profiler.reset();
			expect(profiler.getProfiles()).toEqual([]);
		});
	});

	describe("Sample Collection", () => {
		it("should track multiple nodes in a workflow", () => {
			profiler.addSample("user-api", "validator", 5);
			profiler.addSample("user-api", "db-query", 120);
			profiler.addSample("user-api", "formatter", 3);

			const profiles = profiler.getProfiles();
			expect(profiles[0].nodes.length).toBe(3);
		});

		it("should accumulate multiple samples per node", () => {
			profiler.addSample("wf", "node1", 10);
			profiler.addSample("wf", "node1", 20);
			profiler.addSample("wf", "node1", 30);

			const profiles = profiler.getProfiles();
			const node = profiles[0].nodes[0];
			expect(node.executionCount).toBe(3);
			expect(node.avgTimeMs).toBe(20);
			expect(node.minTimeMs).toBe(10);
			expect(node.maxTimeMs).toBe(30);
		});

		it("should track memory and CPU", () => {
			profiler.addSample("wf", "node1", 10, 50, 15);
			profiler.addSample("wf", "node1", 20, 100, 25);

			const profiles = profiler.getProfiles();
			const node = profiles[0].nodes[0];
			expect(node.memoryAvgMb).toBe(75);
			expect(node.memoryPeakMb).toBe(100);
			expect(node.cpuAvgPct).toBe(20);
		});

		it("should track errors", () => {
			profiler.addSample("wf", "node1", 10, undefined, undefined, false);
			profiler.addSample("wf", "node1", 20, undefined, undefined, true);
			profiler.addSample("wf", "node1", 30, undefined, undefined, false);

			const profiles = profiler.getProfiles();
			const node = profiles[0].nodes[0];
			expect(node.errorCount).toBe(1);
			expect(node.errorRate).toBeCloseTo(1 / 3);
		});

		it("should handle multiple workflows", () => {
			profiler.addSample("wf1", "node1", 10);
			profiler.addSample("wf2", "node2", 20);

			const profiles = profiler.getProfiles();
			expect(profiles.length).toBe(2);
		});
	});

	describe("Percentile Calculations", () => {
		it("should compute percentiles correctly", () => {
			// Add 100 samples from 1 to 100
			for (let i = 1; i <= 100; i++) {
				profiler.addSample("wf", "node1", i);
			}

			const profiles = profiler.getProfiles();
			const node = profiles[0].nodes[0];
			expect(node.p50Ms).toBe(50);
			expect(node.p95Ms).toBe(95);
			expect(node.p99Ms).toBe(99);
		});

		it("should handle single sample percentiles", () => {
			profiler.addSample("wf", "node1", 42);

			const profiles = profiler.getProfiles();
			const node = profiles[0].nodes[0];
			expect(node.p50Ms).toBe(42);
			expect(node.p95Ms).toBe(42);
			expect(node.p99Ms).toBe(42);
		});
	});

	describe("Bottleneck Detection", () => {
		it("should identify the bottleneck node", () => {
			profiler.addSample("wf", "fast-node", 5);
			profiler.addSample("wf", "slow-node", 500);
			profiler.addSample("wf", "medium-node", 50);

			const profiles = profiler.getProfiles();
			expect(profiles[0].bottleneck?.nodeName).toBe("slow-node");
		});

		it("should return top N bottlenecks", () => {
			profiler.addSample("wf", "a", 100);
			profiler.addSample("wf", "b", 200);
			profiler.addSample("wf", "c", 300);
			profiler.addSample("wf", "d", 400);
			profiler.addSample("wf", "e", 500);

			const bottlenecks = profiler.getBottlenecks(3);
			expect(bottlenecks.length).toBe(3);
			expect(bottlenecks[0].nodeName).toBe("e");
			expect(bottlenecks[1].nodeName).toBe("d");
			expect(bottlenecks[2].nodeName).toBe("c");
		});

		it("should compute percentOfTotal correctly", () => {
			profiler.addSample("wf", "fast", 10);
			profiler.addSample("wf", "slow", 90);

			const profiles = profiler.getProfiles();
			const slow = profiles[0].nodes.find((n) => n.nodeName === "slow")!;
			const fast = profiles[0].nodes.find((n) => n.nodeName === "fast")!;

			expect(slow.percentOfTotal).toBeCloseTo(90);
			expect(fast.percentOfTotal).toBeCloseTo(10);
		});
	});

	describe("Hot Path", () => {
		it("should return hot path ordered by time", () => {
			profiler.addSample("wf", "c", 300);
			profiler.addSample("wf", "a", 100);
			profiler.addSample("wf", "b", 200);

			const hotPath = profiler.getHotPath("wf");
			expect(hotPath).toEqual(["c", "b", "a"]);
		});

		it("should return empty for unknown workflow", () => {
			expect(profiler.getHotPath("unknown")).toEqual([]);
		});
	});

	describe("Workflow Totals", () => {
		it("should track workflow-level timing", () => {
			profiler.addSample("wf", "node1", 10);
			profiler.addWorkflowSample("wf", 150);
			profiler.addWorkflowSample("wf", 200);

			const profiles = profiler.getProfiles();
			expect(profiles[0].avgTotalTimeMs).toBe(175);
		});
	});

	describe("Table Output", () => {
		it("should generate a readable table", () => {
			profiler.addSample("user-api", "validator", 5, 12, 2);
			profiler.addSample("user-api", "db-query", 120, 45, 8);
			profiler.addSample("user-api", "formatter", 3, 10, 1);

			const table = profiler.toTable();
			expect(table).toContain("Workflow: user-api");
			expect(table).toContain("Node");
			expect(table).toContain("Avg(ms)");
			expect(table).toContain("validator");
			expect(table).toContain("db-query");
			expect(table).toContain("formatter");
		});

		it("should show bottleneck in header", () => {
			profiler.addSample("wf", "slow", 500);
			profiler.addSample("wf", "fast", 5);

			const table = profiler.toTable();
			expect(table).toContain("Bottleneck: slow");
		});

		it("should handle empty profiler", () => {
			const table = profiler.toTable();
			expect(table).toContain("No profiling data");
		});
	});

	describe("Flame Chart Output", () => {
		it("should generate horizontal bar chart", () => {
			profiler.addSample("wf", "slow", 500);
			profiler.addSample("wf", "fast", 50);

			const chart = profiler.toFlameChart();
			expect(chart).toContain("Workflow: wf");
			expect(chart).toContain("█");
			expect(chart).toContain("slow");
			expect(chart).toContain("fast");
		});

		it("should handle empty profiler", () => {
			const chart = profiler.toFlameChart();
			expect(chart).toContain("No profiling data");
		});

		it("should show percentage", () => {
			profiler.addSample("wf", "node1", 100);
			const chart = profiler.toFlameChart();
			expect(chart).toContain("100%");
		});
	});

	describe("JSON Output", () => {
		it("should generate valid JSON", () => {
			profiler.addSample("wf", "node1", 10, 50, 5, false);
			const json = profiler.toJson();
			const parsed = JSON.parse(json);

			expect(parsed).toBeInstanceOf(Array);
			expect(parsed.length).toBe(1);
			expect(parsed[0].workflowName).toBe("wf");
			expect(parsed[0].nodes.length).toBe(1);
			expect(parsed[0].nodes[0].nodeName).toBe("node1");
			expect(parsed[0].nodes[0].avgTimeMs).toBe(10);
		});
	});

	describe("Configuration", () => {
		it("should respect topN config", () => {
			const limited = new PerformanceProfiler({ topN: 2 });
			limited.addSample("wf", "a", 100);
			limited.addSample("wf", "b", 200);
			limited.addSample("wf", "c", 300);

			const bottlenecks = limited.getBottlenecks();
			expect(bottlenecks.length).toBe(2);
		});
	});
});
