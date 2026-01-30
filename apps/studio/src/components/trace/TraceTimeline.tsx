import { STATUS_DOT_COLORS, TIMELINE_BAR_COLORS } from "@/lib/constants";
import { formatDuration } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { NodeRun, WorkflowRun } from "@/types";
import { useEffect, useMemo, useState } from "react";

interface TraceTimelineProps {
	run: WorkflowRun;
	nodes: NodeRun[];
	selectedNodeId: string | null;
	onSelectNode: (nodeId: string | null) => void;
}

export function TraceTimeline({ run, nodes, selectedNodeId, onSelectNode }: TraceTimelineProps) {
	const { sortedNodes, timelineStart, timelineDuration } = useMemo(() => {
		const sorted = [...nodes].sort((a, b) => a.stepIndex - b.stepIndex);
		const start = run.startedAt;
		const end = run.finishedAt || Date.now();
		return {
			sortedNodes: sorted,
			timelineStart: start,
			timelineDuration: Math.max(end - start, 1),
		};
	}, [nodes, run]);

	return (
		<div className="space-y-0.5">
			{/* Run header bar */}
			<button
				type="button"
				onClick={() => onSelectNode(null)}
				className={cn(
					"w-full flex items-center gap-2 rounded px-2 py-1.5 text-left transition-colors",
					selectedNodeId === null ? "bg-zinc-800" : "hover:bg-zinc-800/50",
				)}
			>
				<span
					className={cn(
						"w-2 h-2 rounded-full flex-shrink-0",
						STATUS_DOT_COLORS[run.status],
						run.status === "running" && "animate-pulse-dot",
					)}
					aria-hidden="true"
				/>
				<span className="text-sm font-medium text-zinc-200 flex-1 truncate">{run.workflowName}</span>
				<span className="text-xs font-mono text-zinc-500">
					{run.status === "running" ? <ElapsedTime startedAt={run.startedAt} /> : formatDuration(run.durationMs)}
				</span>
			</button>

			{/* Node bars */}
			{sortedNodes.map((node) => {
				const nodeStart = node.startedAt - timelineStart;
				const nodeDuration =
					node.status === "running"
						? Date.now() - node.startedAt
						: node.finishedAt
							? node.finishedAt - node.startedAt
							: 0;
				const leftPercent = (nodeStart / timelineDuration) * 100;
				const widthPercent = Math.max((nodeDuration / timelineDuration) * 100, 1);

				return (
					<button
						type="button"
						key={node.id}
						onClick={() => onSelectNode(node.id)}
						className={cn(
							"w-full flex items-center gap-2 rounded px-2 py-1 text-left transition-colors group",
							selectedNodeId === node.id ? "bg-zinc-800" : "hover:bg-zinc-800/50",
						)}
						style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
					>
						{/* Tree connector */}
						{node.depth > 0 && <span className="text-zinc-700 text-xs mr-0.5">{"\u2514"}</span>}

						{/* Status dot */}
						<span
							className={cn(
								"w-2 h-2 rounded-full flex-shrink-0",
								STATUS_DOT_COLORS[node.status],
								node.status === "running" && "animate-pulse-dot",
							)}
							aria-hidden="true"
						/>

						{/* Node name */}
						<span className="text-xs text-zinc-300 flex-shrink-0 truncate max-w-[120px]">{node.nodeName}</span>

						{/* Timeline bar */}
						<div className="flex-1 h-3 relative mx-1">
							<div className="absolute inset-0 bg-zinc-800/50 rounded-sm" />
							<div
								className={cn(
									"absolute top-0 h-full rounded-sm transition-all",
									TIMELINE_BAR_COLORS[node.status],
									node.status === "running" && "animate-grow-bar",
									node.status === "running" && "opacity-80",
								)}
								style={{
									left: `${Math.min(leftPercent, 99)}%`,
									width: `${Math.min(widthPercent, 100 - leftPercent)}%`,
								}}
							/>
						</div>

						{/* Duration */}
						<span className="text-[11px] font-mono text-zinc-500 flex-shrink-0 w-14 text-right">
							{node.status === "running" ? (
								<span className="text-blue-400">...</span>
							) : node.status === "pending" || node.status === "skipped" ? (
								<span className="text-zinc-600">{"\u2014"}</span>
							) : (
								formatDuration(node.durationMs)
							)}
						</span>

						{/* Status icon */}
						<span className="text-xs flex-shrink-0 w-4 text-center">
							{node.status === "completed" && <span className="text-green-400">{"\u2713"}</span>}
							{node.status === "failed" && <span className="text-red-400">{"\u2717"}</span>}
							{node.status === "running" && <span className="text-blue-400">{"\u21BB"}</span>}
							{node.status === "pending" && <span className="text-zinc-600">{"\u25CB"}</span>}
							{node.status === "skipped" && <span className="text-zinc-600">{"\u2014"}</span>}
						</span>
					</button>
				);
			})}

			{/* Time scale */}
			<div className="flex items-center justify-between px-2 pt-2 text-[10px] text-zinc-600 font-mono">
				<span>0ms</span>
				<span>{formatDuration(timelineDuration * 0.25)}</span>
				<span>{formatDuration(timelineDuration * 0.5)}</span>
				<span>{formatDuration(timelineDuration * 0.75)}</span>
				<span>{formatDuration(timelineDuration)}</span>
			</div>
		</div>
	);
}

function ElapsedTime({ startedAt }: { startedAt: number }) {
	const [, setTick] = useState(0);
	useEffect(() => {
		const interval = setInterval(() => setTick((t) => t + 1), 100);
		return () => clearInterval(interval);
	}, []);
	return <span className="text-blue-400">{formatDuration(Date.now() - startedAt)}</span>;
}
