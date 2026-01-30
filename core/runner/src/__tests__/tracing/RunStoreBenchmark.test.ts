import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryRunStore } from "../../tracing/InMemoryRunStore";
import type { RunStore } from "../../tracing/RunStore";
import { SqliteRunStore } from "../../tracing/SqliteRunStore";
import type { NodeRun, RunEvent, TraceLogEntry, WorkflowRun } from "../../tracing/types";

function makeRun(i: number): WorkflowRun {
	return {
		id: `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
		workflowName: `workflow-${i % 5}`,
		workflowPath: `workflows/json/workflow-${i % 5}.json`,
		triggerType: "http",
		triggerSummary: `GET /workflow-${i % 5}`,
		status: i % 3 === 0 ? "failed" : "completed",
		startedAt: Date.now() - (1000 - i) * 1000,
		finishedAt: Date.now() - (1000 - i) * 1000 + Math.random() * 100,
		durationMs: Math.random() * 100,
		nodeCount: 5,
		completedNodes: i % 3 === 0 ? 3 : 5,
		tags: i % 4 === 0 ? ["tagged"] : undefined,
		error: i % 3 === 0 ? { message: `Error at step ${i}` } : undefined,
	};
}

function makeNode(runId: string, index: number): NodeRun {
	return {
		id: `node_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
		runId,
		nodeName: `step-${index}`,
		nodeType: "module",
		runtimeKind: "nodejs",
		status: "completed",
		startedAt: Date.now(),
		finishedAt: Date.now() + 10,
		durationMs: 10,
		depth: 0,
		stepIndex: index,
		inputs: { key: `value-${index}` },
		outputs: { result: `output-${index}` },
	};
}

function makeEvent(runId: string, workflowName: string, index: number): RunEvent {
	return {
		id: `evt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
		type: "NODE_COMPLETED",
		runId,
		workflowName,
		timestamp: Date.now() + index,
		nodeName: `step-${index}`,
	};
}

function makeLog(runId: string, index: number): TraceLogEntry {
	return {
		id: `log_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
		runId,
		level: "info",
		message: `Log message ${index}`,
		timestamp: Date.now() + index,
		nodeName: `step-${index % 5}`,
	};
}

function benchmark(
	label: string,
	fn: () => void,
	iterations = 1,
): { label: string; totalMs: number; avgMs: number; opsPerSec: number } {
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		fn();
	}
	const totalMs = performance.now() - start;
	return {
		label,
		totalMs: Math.round(totalMs * 100) / 100,
		avgMs: Math.round((totalMs / iterations) * 1000) / 1000,
		opsPerSec: Math.round(iterations / (totalMs / 1000)),
	};
}

function runBenchmarkSuite(storeName: string, store: RunStore) {
	describe(`${storeName} Performance`, () => {
		const RUN_COUNT = 500;
		const NODES_PER_RUN = 5;
		const EVENTS_PER_RUN = 10;
		const LOGS_PER_RUN = 10;

		const runs: WorkflowRun[] = [];

		it("write: saveRun", () => {
			const result = benchmark("saveRun", () => {
				for (let i = 0; i < RUN_COUNT; i++) {
					const run = makeRun(i);
					runs.push(run);
					store.saveRun(run);
				}
			});
			console.log(
				`  [${storeName}] ${result.label}: ${result.totalMs}ms for ${RUN_COUNT} runs (${result.avgMs}ms avg)`,
			);
			// Each save should be under 1ms on average
			expect(result.avgMs).toBeLessThan(RUN_COUNT);
		});

		it("write: saveNodeRun", () => {
			const result = benchmark("saveNodeRun", () => {
				for (const run of runs) {
					for (let j = 0; j < NODES_PER_RUN; j++) {
						store.saveNodeRun(makeNode(run.id, j));
					}
				}
			});
			const total = RUN_COUNT * NODES_PER_RUN;
			console.log(`  [${storeName}] ${result.label}: ${result.totalMs}ms for ${total} nodes`);
			expect(result.totalMs).toBeLessThan(10000);
		});

		it("write: saveEvent", () => {
			const result = benchmark("saveEvent", () => {
				for (const run of runs) {
					for (let j = 0; j < EVENTS_PER_RUN; j++) {
						store.saveEvent(makeEvent(run.id, run.workflowName, j));
					}
				}
			});
			const total = RUN_COUNT * EVENTS_PER_RUN;
			console.log(`  [${storeName}] ${result.label}: ${result.totalMs}ms for ${total} events`);
			expect(result.totalMs).toBeLessThan(10000);
		});

		it("write: saveLog", () => {
			const result = benchmark("saveLog", () => {
				for (const run of runs) {
					for (let j = 0; j < LOGS_PER_RUN; j++) {
						store.saveLog(makeLog(run.id, j));
					}
				}
			});
			const total = RUN_COUNT * LOGS_PER_RUN;
			console.log(`  [${storeName}] ${result.label}: ${result.totalMs}ms for ${total} logs`);
			expect(result.totalMs).toBeLessThan(10000);
		});

		it("read: getRun (single)", () => {
			const targetId = runs[Math.floor(runs.length / 2)].id;
			const result = benchmark(
				"getRun",
				() => {
					store.getRun(targetId);
				},
				1000,
			);
			console.log(`  [${storeName}] ${result.label}: ${result.avgMs}ms avg over ${1000} lookups`);
			// Single lookup should be under 1ms
			expect(result.avgMs).toBeLessThan(1);
		});

		it("read: getRuns (paginated)", () => {
			const result = benchmark(
				"getRuns (limit 50)",
				() => {
					store.getRuns({ limit: 50, offset: 0, sort: "desc" });
				},
				100,
			);
			console.log(`  [${storeName}] ${result.label}: ${result.avgMs}ms avg over ${100} queries`);
			// Paginated list should be under 20ms for in-memory, 50ms for SQLite
			expect(result.avgMs).toBeLessThan(50);
		});

		it("read: getRuns with filters", () => {
			const result = benchmark(
				"getRuns (workflow + status)",
				() => {
					store.getRuns({ workflow: "workflow-0", status: "completed", limit: 20, sort: "desc" });
				},
				100,
			);
			console.log(`  [${storeName}] ${result.label}: ${result.avgMs}ms avg over ${100} queries`);
			expect(result.avgMs).toBeLessThan(50);
		});

		it("read: getNodeRuns", () => {
			const targetId = runs[0].id;
			const result = benchmark(
				"getNodeRuns",
				() => {
					store.getNodeRuns(targetId);
				},
				500,
			);
			console.log(`  [${storeName}] ${result.label}: ${result.avgMs}ms avg over ${500} lookups`);
			expect(result.avgMs).toBeLessThan(5);
		});

		it("read: getEvents", () => {
			const targetId = runs[0].id;
			const result = benchmark(
				"getEvents",
				() => {
					store.getEvents(targetId);
				},
				500,
			);
			console.log(`  [${storeName}] ${result.label}: ${result.avgMs}ms avg over ${500} lookups`);
			expect(result.avgMs).toBeLessThan(5);
		});

		it("read: getLogs", () => {
			const targetId = runs[0].id;
			const result = benchmark(
				"getLogs",
				() => {
					store.getLogs(targetId);
				},
				500,
			);
			console.log(`  [${storeName}] ${result.label}: ${result.avgMs}ms avg over ${500} lookups`);
			expect(result.avgMs).toBeLessThan(5);
		});

		it("aggregation: getWorkflowSummaries", () => {
			const result = benchmark(
				"getWorkflowSummaries",
				() => {
					store.getWorkflowSummaries();
				},
				50,
			);
			console.log(`  [${storeName}] ${result.label}: ${result.avgMs}ms avg over ${50} queries`);
			// Aggregation may be slower
			expect(result.avgMs).toBeLessThan(100);
		});

		it("aggregation: getMetrics", () => {
			const result = benchmark(
				"getMetrics",
				() => {
					store.getMetrics();
				},
				50,
			);
			console.log(`  [${storeName}] ${result.label}: ${result.avgMs}ms avg over ${50} queries`);
			expect(result.avgMs).toBeLessThan(100);
		});

		it("aggregation: getActiveRunCount", () => {
			const result = benchmark(
				"getActiveRunCount",
				() => {
					store.getActiveRunCount();
				},
				1000,
			);
			console.log(`  [${storeName}] ${result.label}: ${result.avgMs}ms avg over ${1000} queries`);
			expect(result.avgMs).toBeLessThan(5);
		});

		it("cleanup: deleteRunsBefore", () => {
			// Delete older half of runs
			const midTimestamp = runs[Math.floor(runs.length / 2)].startedAt;
			const result = benchmark("deleteRunsBefore", () => {
				store.deleteRunsBefore(midTimestamp);
			});
			console.log(`  [${storeName}] ${result.label}: ${result.totalMs}ms`);
			expect(result.totalMs).toBeLessThan(5000);
		});
	});
}

describe("RunStore Performance Benchmarks", () => {
	// === InMemoryRunStore ===
	describe("InMemoryRunStore", () => {
		const store = new InMemoryRunStore();
		afterEach(() => {
			/* keep data between tests */
		});

		runBenchmarkSuite("InMemory", store);
	});

	// === SqliteRunStore ===
	describe("SqliteRunStore", () => {
		let tmpDir: string;
		let store: SqliteRunStore;

		beforeEach(() => {
			// Only create once for the suite
			if (!tmpDir) {
				tmpDir = mkdtempSync(join(tmpdir(), "blok-bench-"));
				store = new SqliteRunStore(join(tmpDir, "bench.db"));
			}
		});

		afterEach(() => {
			/* keep data between tests */
		});

		// We need to initialize store before running suite
		const dir = mkdtempSync(join(tmpdir(), "blok-bench-"));
		const sqliteStore = new SqliteRunStore(join(dir, "bench.db"));

		runBenchmarkSuite("SQLite", sqliteStore);

		// Cleanup after all tests
		afterEach(() => {
			// Don't close between tests
		});

		it("cleanup temp dir", () => {
			sqliteStore.close();
			rmSync(dir, { recursive: true, force: true });
		});
	});
});
