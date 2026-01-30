import { StatusBadge } from "@/components/shared/StatusBadge";
import { formatDuration, formatPercent, formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { WorkflowSummary } from "@/types";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Clock, Cpu, Globe, ListOrdered, Radio, Webhook } from "lucide-react";

const TRIGGER_ICON_MAP: Record<string, React.ElementType> = {
	http: Globe,
	cron: Clock,
	queue: ListOrdered,
	worker: Cpu,
	websocket: Radio,
	sse: Radio,
	webhook: Webhook,
};

interface WorkflowCardProps {
	workflow: WorkflowSummary;
}

export function WorkflowCard({ workflow }: WorkflowCardProps) {
	const TriggerIcon = TRIGGER_ICON_MAP[workflow.triggerTypes[0] || "http"] || Globe;

	return (
		<Link
			to="/workflows/$name"
			params={{ name: workflow.name }}
			className="group block rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 hover:border-zinc-700 hover:bg-zinc-900 transition-all"
		>
			<div className="flex items-start justify-between mb-3">
				<div className="flex items-center gap-2.5">
					<div className="p-1.5 rounded-md bg-zinc-800 text-zinc-400 group-hover:bg-zinc-700 transition-colors">
						<TriggerIcon className="w-4 h-4" />
					</div>
					<div>
						<h3 className="text-sm font-medium text-zinc-100 group-hover:text-white transition-colors">
							{workflow.name}
						</h3>
						<span className="text-[11px] text-zinc-500 uppercase tracking-wide">
							{workflow.triggerTypes.join(", ")}
						</span>
					</div>
				</div>
				<ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
			</div>

			<div className="grid grid-cols-3 gap-3 text-xs">
				<div>
					<div className="text-zinc-500 mb-0.5">Runs</div>
					<div className="font-mono text-zinc-300">{workflow.totalRuns}</div>
				</div>
				<div>
					<div className="text-zinc-500 mb-0.5">Avg</div>
					<div className="font-mono text-zinc-300">{formatDuration(workflow.avgDurationMs)}</div>
				</div>
				<div>
					<div className="text-zinc-500 mb-0.5">Errors</div>
					<div className={cn("font-mono", workflow.errorRate > 0.05 ? "text-red-400" : "text-zinc-300")}>
						{formatPercent(workflow.errorRate)}
					</div>
				</div>
			</div>

			{workflow.lastRunStatus && (
				<div className="mt-3 pt-3 border-t border-zinc-800 flex items-center justify-between">
					<StatusBadge status={workflow.lastRunStatus} />
					{workflow.lastRunAt && (
						<span className="text-[11px] text-zinc-500">{formatRelativeTime(workflow.lastRunAt)}</span>
					)}
				</div>
			)}
		</Link>
	);
}
