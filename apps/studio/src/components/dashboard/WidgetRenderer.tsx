import { DurationDistribution } from "@/components/metrics/DurationDistribution";
import { ExecutionTimeline } from "@/components/metrics/ExecutionTimeline";
import { NodePerformance } from "@/components/metrics/NodePerformance";
import { WorkflowBreakdown } from "@/components/metrics/WorkflowBreakdown";
import { formatDuration, formatPercent } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { DashboardWidget, MetricsResponse } from "@/types";

interface WidgetRendererProps {
	widget: DashboardWidget;
	metrics: MetricsResponse | undefined;
}

export function WidgetRenderer({ widget, metrics }: WidgetRendererProps) {
	if (!metrics) {
		return <div className="flex items-center justify-center h-full text-zinc-600 text-xs">Loading...</div>;
	}

	switch (widget.type) {
		case "stat-card":
			return <StatCardWidget widget={widget} metrics={metrics} />;
		case "timeline":
			return <ExecutionTimeline data={metrics.executionTimeline} />;
		case "error-rate":
			return <ErrorRateWidget metrics={metrics} />;
		case "duration-distribution":
			return <DurationDistribution data={metrics.durationDistribution} />;
		case "workflow-breakdown":
			return <WorkflowBreakdown data={metrics.workflowBreakdown} />;
		case "node-performance":
			return <NodePerformance data={metrics.nodePerformance} />;
		case "recent-runs":
			return <RecentRunsSummary metrics={metrics} />;
		case "heatmap":
			return <HeatmapWidget metrics={metrics} />;
		default:
			return <div className="flex items-center justify-center h-full text-zinc-600 text-xs">Unknown widget type</div>;
	}
}

function StatCardWidget({
	widget,
	metrics,
}: {
	widget: DashboardWidget;
	metrics: MetricsResponse;
}) {
	const metricKey = widget.config.metric || "totalRuns";

	const metricMap: Record<string, { value: string; color?: string }> = {
		totalRuns: { value: String(metrics.totalRuns) },
		completedRuns: { value: String(metrics.completedRuns), color: "text-green-400" },
		failedRuns: {
			value: String(metrics.failedRuns),
			color: metrics.failedRuns > 0 ? "text-red-400" : undefined,
		},
		errorRate: {
			value: formatPercent(metrics.totalRuns > 0 ? metrics.failedRuns / metrics.totalRuns : 0),
			color: metrics.failedRuns > 0 ? "text-red-400" : undefined,
		},
		avgDurationMs: { value: formatDuration(metrics.avgDurationMs) },
		p50DurationMs: { value: formatDuration(metrics.p50DurationMs) },
		p95DurationMs: { value: formatDuration(metrics.p95DurationMs) },
		p99DurationMs: { value: formatDuration(metrics.p99DurationMs) },
	};

	const info = metricMap[metricKey] || { value: "N/A" };

	return (
		<div className="flex flex-col items-center justify-center h-full">
			<div className={cn("text-2xl font-bold font-mono", info.color || "text-zinc-100")}>{info.value}</div>
		</div>
	);
}

function ErrorRateWidget({ metrics }: { metrics: MetricsResponse }) {
	const rate = metrics.totalRuns > 0 ? metrics.failedRuns / metrics.totalRuns : 0;
	const pct = (rate * 100).toFixed(1);
	const isHigh = rate > 0.1;

	return (
		<div className="flex flex-col items-center justify-center h-full gap-2">
			<div className={cn("text-3xl font-bold font-mono", isHigh ? "text-red-400" : "text-green-400")}>{pct}%</div>
			<div className="text-xs text-zinc-500">
				{metrics.failedRuns} / {metrics.totalRuns} runs failed
			</div>
		</div>
	);
}

function RecentRunsSummary({ metrics }: { metrics: MetricsResponse }) {
	const total = metrics.totalRuns;
	const completed = metrics.completedRuns;
	const failed = metrics.failedRuns;
	const pending = total - completed - failed;

	return (
		<div className="flex flex-col justify-center h-full gap-2">
			<div className="flex items-center justify-between text-xs">
				<span className="text-zinc-500">Completed</span>
				<span className="font-mono text-green-400">{completed}</span>
			</div>
			<div className="flex items-center justify-between text-xs">
				<span className="text-zinc-500">Failed</span>
				<span className="font-mono text-red-400">{failed}</span>
			</div>
			{pending > 0 && (
				<div className="flex items-center justify-between text-xs">
					<span className="text-zinc-500">In Progress</span>
					<span className="font-mono text-blue-400">{pending}</span>
				</div>
			)}
			{/* Simple bar */}
			<div className="h-2 rounded-full bg-zinc-800 overflow-hidden flex mt-1">
				{completed > 0 && (
					<div className="bg-green-500/70 h-full" style={{ width: `${(completed / Math.max(total, 1)) * 100}%` }} />
				)}
				{failed > 0 && (
					<div className="bg-red-500/70 h-full" style={{ width: `${(failed / Math.max(total, 1)) * 100}%` }} />
				)}
			</div>
		</div>
	);
}

function HeatmapWidget({ metrics }: { metrics: MetricsResponse }) {
	// Use execution timeline data as a heatmap representation
	const data = metrics.executionTimeline;
	const maxTotal = Math.max(...data.map((d) => d.total), 1);

	return (
		<div className="flex flex-col justify-center h-full gap-1">
			<div className="flex gap-0.5 flex-wrap">
				{data.map((bucket) => {
					const intensity = bucket.total / maxTotal;
					const hasFailed = bucket.failed > 0;
					return (
						<div
							key={bucket.bucket}
							className="w-4 h-4 rounded-sm"
							style={{
								backgroundColor: hasFailed
									? `rgba(239, 68, 68, ${Math.max(0.15, intensity)})`
									: `rgba(34, 197, 94, ${Math.max(0.08, intensity * 0.7)})`,
							}}
							title={`${new Date(bucket.bucket).toLocaleTimeString()}: ${bucket.total} runs (${bucket.failed} failed)`}
						/>
					);
				})}
			</div>
			<div className="flex items-center gap-3 text-[10px] text-zinc-600 mt-1">
				<span>Less</span>
				<div className="flex gap-0.5">
					{[0.1, 0.3, 0.5, 0.7, 1].map((intensity) => (
						<div
							key={intensity}
							className="w-3 h-3 rounded-sm"
							style={{
								backgroundColor: `rgba(34, 197, 94, ${intensity * 0.7})`,
							}}
						/>
					))}
				</div>
				<span>More</span>
			</div>
		</div>
	);
}
