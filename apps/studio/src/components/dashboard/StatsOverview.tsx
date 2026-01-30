import { formatDuration, formatPercent } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { WorkflowSummary } from "@/types";
import { Activity, AlertTriangle, CheckCircle, Zap } from "lucide-react";

interface StatsOverviewProps {
	workflows: WorkflowSummary[];
}

export function StatsOverview({ workflows }: StatsOverviewProps) {
	const totalRuns = workflows.reduce((sum, w) => sum + w.totalRuns, 0);
	const activeRuns = workflows.reduce((sum, w) => sum + w.recentRuns, 0);
	const errorRate = totalRuns > 0 ? workflows.reduce((sum, w) => sum + w.errorRate * w.totalRuns, 0) / totalRuns : 0;
	const avgDuration =
		totalRuns > 0 ? workflows.reduce((sum, w) => sum + w.avgDurationMs * w.totalRuns, 0) / totalRuns : 0;

	const stats = [
		{
			label: "Total Runs",
			value: totalRuns.toLocaleString(),
			icon: Activity,
			color: "text-blue-400",
			bgColor: "bg-blue-400/10",
		},
		{
			label: "Recent (24h)",
			value: activeRuns.toLocaleString(),
			icon: Zap,
			color: "text-green-400",
			bgColor: "bg-green-400/10",
		},
		{
			label: "Error Rate",
			value: formatPercent(errorRate),
			icon: AlertTriangle,
			color: errorRate > 0.05 ? "text-red-400" : "text-zinc-400",
			bgColor: errorRate > 0.05 ? "bg-red-400/10" : "bg-zinc-400/10",
		},
		{
			label: "Avg Duration",
			value: formatDuration(avgDuration),
			icon: CheckCircle,
			color: "text-purple-400",
			bgColor: "bg-purple-400/10",
		},
	];

	return (
		<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
			{stats.map((stat) => (
				<div key={stat.label} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
					<div className="flex items-center gap-2 mb-2">
						<div className={cn("p-1.5 rounded-md", stat.bgColor)}>
							<stat.icon className={cn("w-3.5 h-3.5", stat.color)} />
						</div>
						<span className="text-xs text-zinc-500">{stat.label}</span>
					</div>
					<div className="text-xl font-semibold text-zinc-100 font-mono">{stat.value}</div>
				</div>
			))}
		</div>
	);
}
