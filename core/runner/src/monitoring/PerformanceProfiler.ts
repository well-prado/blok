/**
 * Performance Profiler for Blok Workflows
 *
 * Collects and analyzes per-node execution metrics to identify
 * bottlenecks and hot paths in workflow execution.
 *
 * @example
 * ```typescript
 * const profiler = new PerformanceProfiler();
 * profiler.addSample("user-api", "validator", 5.2, 12, 2.1);
 * profiler.addSample("user-api", "db-query", 120.5, 45, 8.3);
 * profiler.addSample("user-api", "formatter", 3.1, 10, 1.2);
 * console.log(profiler.toTable());
 * ```
 */

export interface NodeProfile {
	nodeName: string;
	workflowName: string;
	executionCount: number;
	totalTimeMs: number;
	avgTimeMs: number;
	minTimeMs: number;
	maxTimeMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	memoryAvgMb: number;
	memoryPeakMb: number;
	cpuAvgPct: number;
	errorCount: number;
	errorRate: number;
	percentOfTotal: number;
}

export interface WorkflowProfile {
	workflowName: string;
	totalExecutions: number;
	avgTotalTimeMs: number;
	p95TotalTimeMs: number;
	nodes: NodeProfile[];
	bottleneck: NodeProfile | null;
	hotPath: string[];
}

export interface ProfileConfig {
	topN?: number;
}

interface NodeSamples {
	latencies: number[];
	memories: number[];
	cpus: number[];
	errors: number;
}

const MAX_SAMPLES = 10_000;

export class PerformanceProfiler {
	private config: Required<ProfileConfig>;
	private samples: Map<string, Map<string, NodeSamples>> = new Map();
	private workflowTotals: Map<string, number[]> = new Map();

	constructor(config?: ProfileConfig) {
		this.config = {
			topN: config?.topN ?? 10,
		};
	}

	addSample(
		workflowName: string,
		nodeName: string,
		latencyMs: number,
		memoryMb?: number,
		cpuPct?: number,
		error?: boolean,
	): void {
		if (!this.samples.has(workflowName)) {
			this.samples.set(workflowName, new Map());
		}

		const workflowMap = this.samples.get(workflowName);
		if (!workflowMap) return;
		if (!workflowMap.has(nodeName)) {
			workflowMap.set(nodeName, {
				latencies: [],
				memories: [],
				cpus: [],
				errors: 0,
			});
		}

		const node = workflowMap.get(nodeName);
		if (!node) return;
		node.latencies.push(latencyMs);
		if (memoryMb !== undefined) node.memories.push(memoryMb);
		if (cpuPct !== undefined) node.cpus.push(cpuPct);
		if (error) node.errors++;

		// Trim to max samples
		if (node.latencies.length > MAX_SAMPLES) {
			node.latencies = node.latencies.slice(-MAX_SAMPLES / 2);
		}
		if (node.memories.length > MAX_SAMPLES) {
			node.memories = node.memories.slice(-MAX_SAMPLES / 2);
		}
		if (node.cpus.length > MAX_SAMPLES) {
			node.cpus = node.cpus.slice(-MAX_SAMPLES / 2);
		}
	}

	addWorkflowSample(workflowName: string, totalTimeMs: number): void {
		if (!this.workflowTotals.has(workflowName)) {
			this.workflowTotals.set(workflowName, []);
		}
		this.workflowTotals.get(workflowName)?.push(totalTimeMs);
	}

	getProfiles(): WorkflowProfile[] {
		const profiles: WorkflowProfile[] = [];

		for (const [workflowName, workflowMap] of this.samples) {
			const nodes: NodeProfile[] = [];
			let totalAvgTime = 0;

			for (const [nodeName, data] of workflowMap) {
				const sorted = [...data.latencies].sort((a, b) => a - b);
				const count = sorted.length;
				const sum = sorted.reduce((a, b) => a + b, 0);
				const avg = count > 0 ? sum / count : 0;

				const memAvg = data.memories.length > 0 ? data.memories.reduce((a, b) => a + b, 0) / data.memories.length : 0;
				const memPeak = data.memories.length > 0 ? Math.max(...data.memories) : 0;
				const cpuAvg = data.cpus.length > 0 ? data.cpus.reduce((a, b) => a + b, 0) / data.cpus.length : 0;

				totalAvgTime += avg;

				nodes.push({
					nodeName,
					workflowName,
					executionCount: count,
					totalTimeMs: sum,
					avgTimeMs: avg,
					minTimeMs: count > 0 ? sorted[0] : 0,
					maxTimeMs: count > 0 ? sorted[count - 1] : 0,
					p50Ms: this.percentile(sorted, 50),
					p95Ms: this.percentile(sorted, 95),
					p99Ms: this.percentile(sorted, 99),
					memoryAvgMb: memAvg,
					memoryPeakMb: memPeak,
					cpuAvgPct: cpuAvg,
					errorCount: data.errors,
					errorRate: count > 0 ? data.errors / count : 0,
					percentOfTotal: 0, // computed below
				});
			}

			// Compute percentOfTotal
			for (const node of nodes) {
				node.percentOfTotal = totalAvgTime > 0 ? (node.avgTimeMs / totalAvgTime) * 100 : 0;
			}

			// Sort by avgTimeMs descending
			nodes.sort((a, b) => b.avgTimeMs - a.avgTimeMs);

			// Workflow totals
			const wfTotals = this.workflowTotals.get(workflowName) || [];
			const wfSorted = [...wfTotals].sort((a, b) => a - b);
			const wfAvg = wfSorted.length > 0 ? wfSorted.reduce((a, b) => a + b, 0) / wfSorted.length : totalAvgTime;

			profiles.push({
				workflowName,
				totalExecutions: nodes.length > 0 ? nodes[0].executionCount : 0,
				avgTotalTimeMs: wfAvg,
				p95TotalTimeMs: this.percentile(wfSorted, 95) || wfAvg,
				nodes,
				bottleneck: nodes.length > 0 ? nodes[0] : null,
				hotPath: nodes.map((n) => n.nodeName),
			});
		}

		return profiles;
	}

	getBottlenecks(topN?: number): NodeProfile[] {
		const n = topN ?? this.config.topN;
		const allNodes: NodeProfile[] = [];

		for (const profile of this.getProfiles()) {
			allNodes.push(...profile.nodes);
		}

		allNodes.sort((a, b) => b.avgTimeMs - a.avgTimeMs);
		return allNodes.slice(0, n);
	}

	getHotPath(workflowName: string): string[] {
		const profiles = this.getProfiles();
		const profile = profiles.find((p) => p.workflowName === workflowName);
		return profile?.hotPath ?? [];
	}

	toTable(): string {
		const profiles = this.getProfiles();
		if (profiles.length === 0) return "[No profiling data]";

		const lines: string[] = [];

		for (const profile of profiles) {
			lines.push("");
			lines.push(`  Workflow: ${profile.workflowName}`);
			lines.push(
				`  Avg Total: ${this.fmtMs(profile.avgTotalTimeMs)}  |  P95: ${this.fmtMs(profile.p95TotalTimeMs)}  |  Bottleneck: ${profile.bottleneck?.nodeName ?? "N/A"}`,
			);
			lines.push("");

			// Header
			const header = this.padColumns([
				{ val: "Node", width: 24 },
				{ val: "Count", width: 8 },
				{ val: "Avg(ms)", width: 10 },
				{ val: "P50(ms)", width: 10 },
				{ val: "P95(ms)", width: 10 },
				{ val: "P99(ms)", width: 10 },
				{ val: "Mem(MB)", width: 10 },
				{ val: "CPU(%)", width: 8 },
				{ val: "Err%", width: 7 },
				{ val: "% Total", width: 9 },
			]);

			lines.push(`  ${header}`);
			lines.push(`  ${"─".repeat(header.length)}`);

			const topNodes = profile.nodes.slice(0, this.config.topN);
			for (const node of topNodes) {
				const row = this.padColumns([
					{ val: node.nodeName.length > 22 ? `${node.nodeName.substring(0, 19)}...` : node.nodeName, width: 24 },
					{ val: String(node.executionCount), width: 8 },
					{ val: this.fmtMs(node.avgTimeMs), width: 10 },
					{ val: this.fmtMs(node.p50Ms), width: 10 },
					{ val: this.fmtMs(node.p95Ms), width: 10 },
					{ val: this.fmtMs(node.p99Ms), width: 10 },
					{ val: node.memoryAvgMb > 0 ? node.memoryAvgMb.toFixed(1) : "-", width: 10 },
					{ val: node.cpuAvgPct > 0 ? node.cpuAvgPct.toFixed(1) : "-", width: 8 },
					{ val: (node.errorRate * 100).toFixed(1), width: 7 },
					{ val: `${node.percentOfTotal.toFixed(1)}%`, width: 9 },
				]);
				lines.push(`  ${row}`);
			}
		}

		lines.push("");
		return lines.join("\n");
	}

	toFlameChart(): string {
		const profiles = this.getProfiles();
		if (profiles.length === 0) return "[No profiling data]";

		const lines: string[] = [];
		const maxBarWidth = 50;

		for (const profile of profiles) {
			lines.push("");
			lines.push(`  Workflow: ${profile.workflowName}  (Avg: ${this.fmtMs(profile.avgTotalTimeMs)})`);
			lines.push("");

			const maxTime = profile.nodes.length > 0 ? Math.max(...profile.nodes.map((n) => n.avgTimeMs)) : 1;

			for (const node of profile.nodes.slice(0, this.config.topN)) {
				const barLength = Math.max(1, Math.round((node.avgTimeMs / maxTime) * maxBarWidth));
				const bar = "█".repeat(barLength);
				const name = node.nodeName.length > 20 ? `${node.nodeName.substring(0, 17)}...` : node.nodeName;
				const padded = name + " ".repeat(Math.max(0, 20 - name.length));
				lines.push(`  ${padded} ${bar} ${this.fmtMs(node.avgTimeMs)} (${node.percentOfTotal.toFixed(0)}%)`);
			}
		}

		lines.push("");
		return lines.join("\n");
	}

	toJson(): string {
		return JSON.stringify(this.getProfiles(), null, 2);
	}

	reset(): void {
		this.samples.clear();
		this.workflowTotals.clear();
	}

	// -- Internal --

	private percentile(sorted: number[], p: number): number {
		if (sorted.length === 0) return 0;
		const index = Math.ceil((p / 100) * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
	}

	private fmtMs(ms: number): string {
		if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
		if (ms >= 1) return ms.toFixed(1);
		return ms.toFixed(3);
	}

	private padColumns(cols: Array<{ val: string; width: number }>): string {
		return cols.map((c) => c.val + " ".repeat(Math.max(0, c.width - c.val.length))).join("");
	}
}
