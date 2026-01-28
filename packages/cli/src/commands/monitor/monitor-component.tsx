import chalk from "chalk";
import { Box, Text, render, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";

type SortBy = "time" | "memory" | "cpu" | "errors" | "requests";
type ViewMode = "workflows" | "system" | "triggers" | "runtimes";

type NodeMetrics = {
	name: string;
	requests: number;
	timeMs: number;
	memoryMb: number;
	cpuPct: number;
	errors: number;
};

type WorkflowMetrics = {
	workflow: string;
	totalTimeMs: number;
	totalMemoryMb: number;
	totalCpuPct: number;
	errors: number;
	requests: number;
	nodes: NodeMetrics[];
};

type SystemMetrics = {
	uptime: number;
	totalRequests: number;
	totalErrors: number;
	avgResponseMs: number;
	memoryUsageMb: number;
	cpuUsagePct: number;
	activeWorkflows: number;
	errorRate: number;
};

type TriggerStatus = {
	name: string;
	type: string;
	status: "healthy" | "degraded" | "unhealthy";
	requests: number;
	errors: number;
	avgLatencyMs: number;
};

type RuntimeStatus = {
	kind: string;
	status: "active" | "inactive" | "error";
	executions: number;
	avgDurationMs: number;
	errors: number;
};

type WorkflowNumberKeys = Exclude<keyof WorkflowMetrics, "workflow" | "nodes">;
type NodeNumberKeys = Exclude<keyof NodeMetrics, "name">;

type PrometheusMetricResult = {
	metric: Record<string, string>;
	value: [number, string];
};

const PROM_URL = "http://localhost:9090/api/v1/query";

const fmt = (val: number | undefined, decimals = 1) => {
	let valNew = (val ?? 0).toFixed(decimals);
	if (valNew.toString() === "NaN") {
		valNew = "0";
	}

	return valNew;
};

const queryPrometheus = async (query: string, host?: string, token?: string) => {
	const REMOTE_PROM_URL = host ? `${host}/api/v1/query` : undefined;
	try {
		const res = token
			? await fetch(`${REMOTE_PROM_URL || PROM_URL}?query=${encodeURIComponent(query)}`, {
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/json",
						"Accept-Encoding": "identity",
					},
				})
			: await fetch(`${REMOTE_PROM_URL || PROM_URL}?query=${encodeURIComponent(query)}`);

		if (!res.ok) {
			return [];
		}

		const data = await res.json();
		return data.data.result || [];
	} catch {
		return [];
	}
};

const fetchSystemMetrics = async (host?: string, token?: string): Promise<SystemMetrics> => {
	const [uptimeRaw, totalReqs, totalErrs, avgResp, memUsage, cpuUsage] = await Promise.all([
		queryPrometheus("process_uptime_seconds", host, token),
		queryPrometheus("sum(increase(workflow_total[5m]))", host, token),
		queryPrometheus("sum(increase(workflow_errors_total[5m]))", host, token),
		queryPrometheus("avg(increase(workflow_time[5m]))", host, token),
		queryPrometheus("process_resident_memory_bytes / 1024 / 1024", host, token),
		queryPrometheus("rate(process_cpu_seconds_total[1m]) * 100", host, token),
	]);

	const totalRequests = +(totalReqs[0]?.value?.[1] ?? "0");
	const totalErrors = +(totalErrs[0]?.value?.[1] ?? "0");

	return {
		uptime: +(uptimeRaw[0]?.value?.[1] ?? "0"),
		totalRequests: Math.round(totalRequests),
		totalErrors: Math.round(totalErrors),
		avgResponseMs: +(avgResp[0]?.value?.[1] ?? "0"),
		memoryUsageMb: +(memUsage[0]?.value?.[1] ?? "0"),
		cpuUsagePct: +(cpuUsage[0]?.value?.[1] ?? "0"),
		activeWorkflows: 0, // Will be set from workflow count
		errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
	};
};

const fetchTriggerStatus = async (host?: string, token?: string): Promise<TriggerStatus[]> => {
	const [triggerReqs, triggerErrs, triggerLatency] = await Promise.all([
		queryPrometheus("sum(increase(workflow_total[5m])) by (workflow_name)", host, token),
		queryPrometheus("sum(increase(workflow_errors_total[5m])) by (workflow_name)", host, token),
		queryPrometheus("avg(increase(workflow_time[5m])) by (workflow_name)", host, token),
	]);

	const triggers: Record<string, TriggerStatus> = {};

	for (const entry of triggerReqs as PrometheusMetricResult[]) {
		const name = entry.metric.workflow_name || "unknown";
		if (!triggers[name]) {
			triggers[name] = { name, type: "http", status: "healthy", requests: 0, errors: 0, avgLatencyMs: 0 };
		}
		triggers[name].requests = Math.round(+(entry.value?.[1] ?? "0"));
	}

	for (const entry of triggerErrs as PrometheusMetricResult[]) {
		const name = entry.metric.workflow_name || "unknown";
		if (triggers[name]) {
			triggers[name].errors = Math.round(+(entry.value?.[1] ?? "0"));
			if (triggers[name].errors > 0) {
				const errorRate = triggers[name].requests > 0 ? triggers[name].errors / triggers[name].requests : 1;
				triggers[name].status = errorRate > 0.5 ? "unhealthy" : "degraded";
			}
		}
	}

	for (const entry of triggerLatency as PrometheusMetricResult[]) {
		const name = entry.metric.workflow_name || "unknown";
		if (triggers[name]) {
			triggers[name].avgLatencyMs = +(entry.value?.[1] ?? "0");
		}
	}

	return Object.values(triggers);
};

const fetchPrometheusMetrics = async (host?: string, token?: string): Promise<WorkflowMetrics[]> => {
	const [wfReqs, wfTime, wfErrors, wfCPU, wfMem] = await Promise.all([
		queryPrometheus("(sum(increase(workflow_total[1m])) by (workflow_path)) > 0", host, token),
		queryPrometheus("sum(increase(workflow_time[1m])) by (workflow_path)", host, token),
		queryPrometheus("(sum(increase(workflow_errors_total[1m])) by (workflow_path)) > 0", host, token),
		queryPrometheus("sum(increase(workflow_cpu[1m])) by (workflow_path)", host, token),
		queryPrometheus("sum(increase(workflow_memory[1m])) by (workflow_path)", host, token),
	]);

	const wfMap: Record<string, WorkflowMetrics> = {};

	const mapWorkflow = (list: PrometheusMetricResult[], key: WorkflowNumberKeys, convert: (val: string) => number) => {
		for (const entry of list) {
			const name = entry.metric.workflow_path;
			if (!name) continue;
			if (!wfMap[name]) {
				wfMap[name] = {
					workflow: name,
					totalTimeMs: 0,
					totalMemoryMb: 0,
					totalCpuPct: 0,
					errors: 0,
					requests: 0,
					nodes: [],
				};
			}
			wfMap[name][key] = convert(entry.value?.[1] ?? "0");
		}
	};

	mapWorkflow(wfTime, "totalTimeMs", (v) => +v);
	mapWorkflow(wfMem, "totalMemoryMb", (v) => +v);
	mapWorkflow(wfCPU, "totalCpuPct", (v) => +v);
	mapWorkflow(wfErrors, "errors", (v) => Math.round(+v));
	mapWorkflow(wfReqs, "requests", (v) => Math.round(+v));

	const nodeMetricsRaw = await Promise.all([
		queryPrometheus("(sum(increase(node_total[1m])) by (node_name, workflow_path)) > 0", host, token),
		queryPrometheus("sum(increase(node_time[1m])) by (node_name, workflow_path)", host, token),
		queryPrometheus("(sum(increase(node_errors_total[1m])) by (node_name, workflow_path)) > 0", host, token),
		queryPrometheus("sum(increase(node_cpu[1m])) by (node_name, workflow_path)", host, token),
		queryPrometheus("sum(increase(node_memory[1m])) by (node_name, workflow_path)", host, token),
	]);

	const nodeMap: Record<string, Record<string, Partial<NodeMetrics>>> = {};

	const setNodeMetric = (list: PrometheusMetricResult[], key: NodeNumberKeys, convert: (val: string) => number) => {
		for (const entry of list) {
			const wf = entry.metric.workflow_path;
			const node = entry.metric.node_name;
			if (!wf || !node) continue;

			if (!nodeMap[wf]) nodeMap[wf] = {};
			if (!nodeMap[wf][node]) nodeMap[wf][node] = { name: node };

			const raw = Number.parseFloat(entry.value?.[1] ?? "0");
			nodeMap[wf][node][key] = convert(raw.toString());
		}
	};

	setNodeMetric(nodeMetricsRaw[0], "requests", (v) => +v);
	setNodeMetric(nodeMetricsRaw[1], "timeMs", (v) => +v);
	setNodeMetric(nodeMetricsRaw[4], "memoryMb", (v) => +v);
	setNodeMetric(nodeMetricsRaw[3], "cpuPct", (v) => +v);
	setNodeMetric(nodeMetricsRaw[2], "errors", (v) => Math.round(+v));

	for (const wf of Object.keys(nodeMap)) {
		const wfObj = wfMap[wf];
		if (!wfObj) continue;
		const nodes = Object.values(nodeMap[wf]) as NodeMetrics[];
		wfObj.nodes = nodes;
	}

	return Object.values(wfMap);
};

// --- Helper: format uptime ---
const formatUptime = (seconds: number): string => {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${mins}m`;
};

// --- Helper: status indicator ---
const statusIndicator = (status: string): string => {
	switch (status) {
		case "healthy":
		case "active":
			return chalk.green("UP");
		case "degraded":
			return chalk.yellow("WARN");
		case "unhealthy":
		case "error":
			return chalk.red("DOWN");
		default:
			return chalk.gray("--");
	}
};

// --- System Overview Panel ---
const SystemPanel: React.FC<{ system: SystemMetrics }> = ({ system }) => (
	<Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
		<Text bold>{chalk.cyan(" System Overview ")}</Text>
		<Box flexDirection="row" marginTop={1}>
			<Box flexDirection="column" width="25%">
				<Text dimColor>Uptime</Text>
				<Text bold>{formatUptime(system.uptime)}</Text>
			</Box>
			<Box flexDirection="column" width="25%">
				<Text dimColor>Requests (5m)</Text>
				<Text bold>{fmt(system.totalRequests, 0)}</Text>
			</Box>
			<Box flexDirection="column" width="25%">
				<Text dimColor>Error Rate</Text>
				<Text bold color={system.errorRate > 5 ? "red" : system.errorRate > 1 ? "yellow" : "green"}>
					{fmt(system.errorRate)}%
				</Text>
			</Box>
			<Box flexDirection="column" width="25%">
				<Text dimColor>Avg Response</Text>
				<Text bold>{fmt(system.avgResponseMs, 0)}ms</Text>
			</Box>
		</Box>
		<Box flexDirection="row" marginTop={1}>
			<Box flexDirection="column" width="25%">
				<Text dimColor>Memory</Text>
				<Text bold>{fmt(system.memoryUsageMb)}MB</Text>
			</Box>
			<Box flexDirection="column" width="25%">
				<Text dimColor>CPU</Text>
				<Text bold>{fmt(system.cpuUsagePct)}%</Text>
			</Box>
			<Box flexDirection="column" width="25%">
				<Text dimColor>Errors (5m)</Text>
				<Text bold color={system.totalErrors > 0 ? "red" : "green"}>
					{fmt(system.totalErrors, 0)}
				</Text>
			</Box>
			<Box flexDirection="column" width="25%">
				<Text dimColor>Workflows</Text>
				<Text bold>{system.activeWorkflows}</Text>
			</Box>
		</Box>
	</Box>
);

// --- Trigger Status Panel ---
const TriggersPanel: React.FC<{ triggers: TriggerStatus[] }> = ({ triggers }) => (
	<Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
		<Text bold>{chalk.magenta(" Trigger Status ")}</Text>
		{triggers.length === 0 ? (
			<Text dimColor> No trigger data available</Text>
		) : (
			<>
				<Text>{chalk.gray("  ┌────────────────────────┬──────────┬──────────┬──────────┬────────────┬────────┐")}</Text>
				<Text>{chalk.gray("  │ Trigger                │ Type     │ Status   │ Requests │ Latency    │ Errors │")}</Text>
				<Text>{chalk.gray("  ├────────────────────────┼──────────┼──────────┼──────────┼────────────┼────────┤")}</Text>
				{triggers.map((t) => (
					<Text key={t.name}>
						{`  │ ${t.name.slice(0, 22).padEnd(22)} │ ${t.type.padEnd(8)} │ ${statusIndicator(t.status).padEnd(17)} │ ${fmt(t.requests, 0).padStart(8)} │ ${fmt(t.avgLatencyMs, 0).padStart(8)}ms │ ${
							t.errors > 0
								? chalk.red(t.errors.toString().padStart(6))
								: chalk.green("     0")
						} │`}
					</Text>
				))}
				<Text>{chalk.gray("  └────────────────────────┴──────────┴──────────┴──────────┴────────────┴────────┘")}</Text>
			</>
		)}
	</Box>
);

// --- Runtime Status Panel ---
const RuntimesPanel: React.FC<{ runtimes: RuntimeStatus[] }> = ({ runtimes }) => {
	// Default runtimes if none from Prometheus
	const displayRuntimes = runtimes.length > 0 ? runtimes : [
		{ kind: "nodejs", status: "active" as const, executions: 0, avgDurationMs: 0, errors: 0 },
		{ kind: "python3", status: "inactive" as const, executions: 0, avgDurationMs: 0, errors: 0 },
		{ kind: "docker", status: "inactive" as const, executions: 0, avgDurationMs: 0, errors: 0 },
	];

	return (
		<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
			<Text bold>{chalk.yellow(" Runtime Adapters ")}</Text>
			<Box flexDirection="row" marginTop={1}>
				{displayRuntimes.map((rt) => (
					<Box key={rt.kind} flexDirection="column" marginRight={3}>
						<Text bold>{rt.kind.toUpperCase()}</Text>
						<Text>{statusIndicator(rt.status)}</Text>
						<Text dimColor>Exec: {fmt(rt.executions, 0)}</Text>
						<Text dimColor>Avg: {fmt(rt.avgDurationMs, 0)}ms</Text>
						<Text dimColor>
							Err: {rt.errors > 0 ? chalk.red(rt.errors.toString()) : "0"}
						</Text>
					</Box>
				))}
			</Box>
		</Box>
	);
};

// --- Workflow Detail Panel (existing, enhanced) ---
const WorkflowsPanel: React.FC<{
	workflows: WorkflowMetrics[];
	sortBy: SortBy;
}> = ({ workflows, sortBy }) => {
	const sorted = [...workflows].sort((a, b) => {
		if (sortBy === "time") return b.totalTimeMs - a.totalTimeMs;
		if (sortBy === "memory") return b.totalMemoryMb - a.totalMemoryMb;
		if (sortBy === "cpu") return b.totalCpuPct - a.totalCpuPct;
		if (sortBy === "errors") return b.errors - a.errors;
		if (sortBy === "requests") return b.requests - a.requests;
		return 0;
	});

	return (
		<Box flexDirection="column">
			{sorted.length === 0 ? (
				<Text dimColor> No workflow metrics available. Execute a workflow to see data.</Text>
			) : (
				sorted.map((wf) => (
					<Box key={wf.workflow} flexDirection="column" marginTop={1}>
						<Text bold>
							{`Workflow: ${wf.workflow} | Time: ${fmt(
								wf.totalTimeMs,
								0,
							)}ms | RAM: ${fmt(wf.totalMemoryMb)}MB | CPU: ${fmt(
								wf.totalCpuPct,
							)}% | Reqs: ${fmt(wf.requests, 0)} | Errs: ${fmt(wf.errors, 0)}`}
						</Text>
						<Box flexDirection="column" paddingLeft={2}>
							{wf.nodes.length > 0 ? (
								<>
									<Text>
										{chalk.gray("  ┌──────────────────────┬───────────┬───────────┬──────────┬────────┬─────────┐")}
									</Text>
									<Text>
										{chalk.gray("  │ Node                 │ Requests  │ Time(ms)  │ Mem(MB)  │ CPU(%) │ Errors  │")}
									</Text>
									<Text>
										{chalk.gray("  ├──────────────────────┼───────────┼───────────┼──────────┼────────┼─────────┤")}
									</Text>
									{wf.nodes.map((node) => (
										<Text key={node.name}>
											{`  │ ${node.name.slice(0, 20).padEnd(20)} │ ${fmt(node.requests, 0).padStart(9)} | ${fmt(
												node.timeMs,
												0,
											).padStart(9)} │ ${fmt(node.memoryMb).padStart(8)} │ ${fmt(node.cpuPct).padStart(6)} │ ${
												(node.errors ?? 0) > 0
													? chalk.red((node.errors ?? 0).toString().padStart(7))
													: chalk.green("      0")
											} │`}
										</Text>
									))}
									<Text>
										{chalk.gray("  └──────────────────────┴───────────┴───────────┴──────────┴────────┴─────────┘")}
									</Text>
								</>
							) : (
								<Text dimColor> (No node-level data)</Text>
							)}
						</Box>
					</Box>
				))
			)}
		</Box>
	);
};

// --- Main Monitor Component ---
const Monitor: React.FC<{ host?: string; token?: string }> = ({ host, token }) => {
	const [workflows, setWorkflows] = useState<WorkflowMetrics[]>([]);
	const [system, setSystem] = useState<SystemMetrics>({
		uptime: 0, totalRequests: 0, totalErrors: 0, avgResponseMs: 0,
		memoryUsageMb: 0, cpuUsagePct: 0, activeWorkflows: 0, errorRate: 0,
	});
	const [triggers, setTriggers] = useState<TriggerStatus[]>([]);
	const [runtimes] = useState<RuntimeStatus[]>([]);
	const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
	const [sortBy, setSortBy] = useState<SortBy>("time");
	const [view, setView] = useState<ViewMode>("workflows");

	useEffect(() => {
		const fetchAll = async () => {
			const [wfResult, sysResult, trigResult] = await Promise.all([
				fetchPrometheusMetrics(host, token),
				fetchSystemMetrics(host, token),
				fetchTriggerStatus(host, token),
			]);
			sysResult.activeWorkflows = wfResult.length;
			setWorkflows(wfResult);
			setSystem(sysResult);
			setTriggers(trigResult);
			setLastUpdate(new Date());
		};

		fetchAll();
		const interval = setInterval(fetchAll, 3000);
		return () => clearInterval(interval);
	}, [host, token]);

	useInput((input) => {
		// Sort controls
		if (input === "w") setSortBy("time");
		else if (input === "m") setSortBy("memory");
		else if (input === "c") setSortBy("cpu");
		else if (input === "e") setSortBy("errors");
		else if (input === "r") setSortBy("requests");
		// View controls
		else if (input === "1") setView("workflows");
		else if (input === "2") setView("system");
		else if (input === "3") setView("triggers");
		else if (input === "4") setView("runtimes");
		// Quit
		else if (input === "q") process.exit(0);
	});

	return (
		<Box flexDirection="column" padding={1}>
			{/* Header */}
			<Text bold>
				{chalk.cyan("Blok Monitor")}
				{chalk.gray(` — ${lastUpdate.toLocaleTimeString()}`)}
				{chalk.gray(` | Uptime: ${formatUptime(system.uptime)}`)}
				{chalk.gray(` | ${system.totalRequests} reqs`)}
				{system.totalErrors > 0 ? chalk.red(` | ${system.totalErrors} errs`) : ""}
			</Text>

			{/* Navigation */}
			<Text dimColor>
				{`[1] Workflows${view === "workflows" ? "*" : ""}  [2] System${view === "system" ? "*" : ""}  [3] Triggers${view === "triggers" ? "*" : ""}  [4] Runtimes${view === "runtimes" ? "*" : ""}  | Sort: [w]Time [m]Mem [c]CPU [r]Req [e]Err  [q]Quit`}
			</Text>

			{/* Quick Stats Bar */}
			<Box marginTop={1}>
				<Text>
					{chalk.green(`Reqs: ${fmt(system.totalRequests, 0)}`)}
					{"  "}
					{chalk.yellow(`Avg: ${fmt(system.avgResponseMs, 0)}ms`)}
					{"  "}
					{system.totalErrors > 0
						? chalk.red(`Errors: ${fmt(system.totalErrors, 0)}`)
						: chalk.green("Errors: 0")}
					{"  "}
					{chalk.blue(`Mem: ${fmt(system.memoryUsageMb)}MB`)}
					{"  "}
					{chalk.magenta(`CPU: ${fmt(system.cpuUsagePct)}%`)}
				</Text>
			</Box>

			{/* Active View */}
			<Box marginTop={1} flexDirection="column">
				{view === "workflows" && (
					<WorkflowsPanel workflows={workflows} sortBy={sortBy} />
				)}
				{view === "system" && (
					<SystemPanel system={system} />
				)}
				{view === "triggers" && (
					<TriggersPanel triggers={triggers} />
				)}
				{view === "runtimes" && (
					<RuntimesPanel runtimes={runtimes} />
				)}
			</Box>
		</Box>
	);
};

export const runMonitor = (host?: string, token?: string) => {
	render(<Monitor host={host} token={token} />);
};
