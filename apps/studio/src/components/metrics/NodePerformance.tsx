import { formatDuration, formatPercent } from "@/lib/formatters";
import { cn } from "@/lib/utils";

interface NodeStat {
	nodeName: string;
	avgDurationMs: number;
	maxDurationMs: number;
	errorRate: number;
	executionCount: number;
}

interface Props {
	data: NodeStat[];
}

export function NodePerformance({ data }: Props) {
	const maxAvg = Math.max(...data.map((d) => d.avgDurationMs), 1);

	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-zinc-800">
						<th className="text-left px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
							Node
						</th>
						<th className="text-left px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
							Avg Duration
						</th>
						<th className="text-left px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
							Max
						</th>
						<th className="text-left px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
							Runs
						</th>
						<th className="text-left px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
							Error Rate
						</th>
					</tr>
				</thead>
				<tbody>
					{data
						.sort((a, b) => b.avgDurationMs - a.avgDurationMs)
						.map((node) => (
							<tr key={node.nodeName} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
								<td className="px-2 py-2">
									<div className="flex items-center gap-2">
										<span className="text-xs font-medium text-zinc-300">{node.nodeName}</span>
									</div>
									{/* Mini bar */}
									<div className="h-1 bg-zinc-800 rounded-full overflow-hidden mt-1 max-w-32">
										<div
											className="h-full bg-blue-500/60 rounded-full"
											style={{ width: `${(node.avgDurationMs / maxAvg) * 100}%` }}
										/>
									</div>
								</td>
								<td className="px-2 py-2">
									<span className="text-xs font-mono text-zinc-400">{formatDuration(node.avgDurationMs)}</span>
								</td>
								<td className="px-2 py-2">
									<span className="text-xs font-mono text-zinc-500">{formatDuration(node.maxDurationMs)}</span>
								</td>
								<td className="px-2 py-2">
									<span className="text-xs font-mono text-zinc-500">{node.executionCount}</span>
								</td>
								<td className="px-2 py-2">
									<span
										className={cn(
											"text-xs font-mono",
											node.errorRate > 0.1 ? "text-red-400" : node.errorRate > 0 ? "text-amber-400" : "text-green-500",
										)}
									>
										{formatPercent(node.errorRate)}
									</span>
								</td>
							</tr>
						))}
				</tbody>
			</table>
		</div>
	);
}
