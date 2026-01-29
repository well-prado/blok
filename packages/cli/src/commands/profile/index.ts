import fs from "node:fs";
import * as p from "@clack/prompts";
import { type OptionValues, program, trackCommandExecution } from "../../services/commander.js";

async function getPerformanceProfiler() {
	const { PerformanceProfiler } = await import("@nanoservice-ts/runner");
	return PerformanceProfiler;
}

async function queryPrometheus(
	query: string,
	host: string,
	token?: string | null,
): Promise<Array<{ metric: Record<string, string>; value: [number, string] }>> {
	try {
		const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
		if (token) headers.Authorization = `Bearer ${token}`;

		const response = await fetch(`${host}/api/v1/query`, {
			method: "POST",
			headers,
			body: `query=${encodeURIComponent(query)}`,
		});

		if (!response.ok) return [];

		const data = (await response.json()) as {
			data?: { result?: Array<{ metric: Record<string, string>; value: [number, string] }> };
		};
		return data?.data?.result ?? [];
	} catch {
		return [];
	}
}

program
	.command("profile [workflow-name]")
	.description("Profile workflow execution performance and identify bottlenecks")
	.option("--duration <seconds>", "Duration to collect metrics", "30")
	.option("--format <format>", "Output format: table, flamechart, json", "table")
	.option("--output <file>", "Write output to file")
	.option("--host <host>", "Prometheus host", "http://localhost:9090")
	.option("--token <token>", "Prometheus auth token")
	.option("--top <count>", "Show top N bottlenecks", "10")
	.action(async (workflowName: string | undefined, options: OptionValues) => {
		await trackCommandExecution({
			command: "profile",
			args: options,
			execution: async () => {
				const logger = p.spinner();
				logger.start("Collecting performance metrics from Prometheus...");

				const host = (options.host as string) || "http://localhost:9090";
				const token = options.token as string | undefined;
				const topN = Number.parseInt(options.top as string, 10) || 10;

				// Query per-node metrics from Prometheus
				const [nodeTimeResults, _nodeCountResults, nodeMemResults, _nodeCpuResults, _nodeErrResults] =
					await Promise.all([
						queryPrometheus("node_time", host, token),
						queryPrometheus("node_total", host, token),
						queryPrometheus("node_memory", host, token),
						queryPrometheus("node_cpu", host, token),
						queryPrometheus("node_errors_total", host, token),
					]);

				const PerformanceProfiler = await getPerformanceProfiler();
				const profiler = new PerformanceProfiler({ topN });

				let hasData = false;

				// Process node time metrics
				for (const result of nodeTimeResults) {
					const wf = result.metric.workflow || "unknown";
					const node = result.metric.node || result.metric.name || "unknown";

					if (workflowName && wf !== workflowName) continue;

					const timeMs = Number.parseFloat(result.value[1]) || 0;
					if (timeMs > 0) {
						profiler.addSample(wf, node, timeMs);
						hasData = true;
					}
				}

				// Process memory metrics
				for (const result of nodeMemResults) {
					const wf = result.metric.workflow || "unknown";
					const node = result.metric.node || result.metric.name || "unknown";
					if (workflowName && wf !== workflowName) continue;

					const memMb = Number.parseFloat(result.value[1]) || 0;
					if (memMb > 0) {
						profiler.addSample(wf, node, 0, memMb);
					}
				}

				if (!hasData) {
					logger.stop("No profiling data available.", 1);
					p.log.warn("Make sure Prometheus is running and workflows have been executed.");
					p.log.info(`Tried connecting to: ${host}`);
					return;
				}

				logger.stop("Metrics collected.");

				let output: string;
				const format = options.format as string;

				switch (format) {
					case "flamechart":
						output = profiler.toFlameChart();
						break;
					case "json":
						output = profiler.toJson();
						break;
					default:
						output = profiler.toTable();
				}

				if (options.output) {
					fs.writeFileSync(options.output as string, output, "utf-8");
					p.log.success(`Profile written to ${options.output}`);
				} else {
					console.log(output);
				}

				// Show bottleneck summary
				const bottlenecks = profiler.getBottlenecks(3);
				if (bottlenecks.length > 0) {
					p.log.info("Top bottlenecks:");
					for (const b of bottlenecks) {
						p.log.message(
							`  ${b.nodeName}: avg ${b.avgTimeMs.toFixed(1)}ms (${b.percentOfTotal.toFixed(0)}% of total)`,
						);
					}
				}
			},
		});
	});
