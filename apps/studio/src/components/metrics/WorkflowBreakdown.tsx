import { formatDuration, formatPercent } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";

interface WorkflowStat {
	name: string;
	totalRuns: number;
	errorRate: number;
	avgDurationMs: number;
}

interface Props {
	data: WorkflowStat[];
}

export function WorkflowBreakdown({ data }: Props) {
	const maxRuns = Math.max(...data.map((d) => d.totalRuns), 1);

	return (
		<div className="space-y-2">
			{data
				.sort((a, b) => b.totalRuns - a.totalRuns)
				.map((wf) => (
					<Link
						key={wf.name}
						to="/workflows/$name"
						params={{ name: wf.name }}
						className="flex items-center gap-3 p-2 rounded-md hover:bg-zinc-800/50 transition-colors group"
					>
						{/* Bar */}
						<div className="flex-1 min-w-0">
							<div className="flex items-center justify-between mb-1">
								<span className="text-xs font-medium text-zinc-300 truncate group-hover:text-zinc-100">{wf.name}</span>
								<span className="text-[10px] font-mono text-zinc-500 shrink-0 ml-2">{wf.totalRuns} runs</span>
							</div>
							<div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
								<div
									className={cn(
										"h-full rounded-full transition-all",
										wf.errorRate > 0.1 ? "bg-red-500/60" : wf.errorRate > 0 ? "bg-amber-500/60" : "bg-green-500/60",
									)}
									style={{ width: `${(wf.totalRuns / maxRuns) * 100}%` }}
								/>
							</div>
						</div>
						{/* Stats */}
						<div className="shrink-0 text-right">
							<div className="text-[10px] font-mono text-zinc-500">{formatDuration(wf.avgDurationMs)}</div>
							<div
								className={cn(
									"text-[10px] font-mono",
									wf.errorRate > 0.1 ? "text-red-400" : wf.errorRate > 0 ? "text-amber-400" : "text-green-400",
								)}
							>
								{formatPercent(wf.errorRate)} err
							</div>
						</div>
					</Link>
				))}
		</div>
	);
}
