import { LOG_LEVEL_COLORS } from "@/lib/constants";
import { formatTimestamp } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { TraceLogEntry } from "@/types";
import { ArrowDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface LogViewerProps {
	logs: TraceLogEntry[];
	nodeNames: string[];
}

export function LogViewer({ logs, nodeNames }: LogViewerProps) {
	const [levelFilter, setLevelFilter] = useState<string>("");
	const [nodeFilter, setNodeFilter] = useState<string>("");
	const [autoScroll, setAutoScroll] = useState(true);
	const scrollRef = useRef<HTMLDivElement>(null);

	const filteredLogs = useMemo(() => {
		return logs.filter((log) => {
			if (levelFilter && log.level !== levelFilter) return false;
			if (nodeFilter && log.nodeName !== nodeFilter) return false;
			return true;
		});
	}, [logs, levelFilter, nodeFilter]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally using filteredLogs.length to scroll only on count change
	useEffect(() => {
		if (autoScroll && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [filteredLogs.length, autoScroll]);

	return (
		<div className="flex flex-col h-full">
			{/* Filters */}
			<div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 shrink-0">
				<select
					value={levelFilter}
					onChange={(e) => setLevelFilter(e.target.value)}
					className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none focus:border-zinc-600"
				>
					<option value="">All levels</option>
					<option value="debug">Debug</option>
					<option value="info">Info</option>
					<option value="warn">Warn</option>
					<option value="error">Error</option>
				</select>

				{nodeNames.length > 0 && (
					<select
						value={nodeFilter}
						onChange={(e) => setNodeFilter(e.target.value)}
						className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none focus:border-zinc-600"
					>
						<option value="">All nodes</option>
						{nodeNames.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
				)}

				<div className="ml-auto">
					<button
						type="button"
						onClick={() => setAutoScroll(!autoScroll)}
						className={cn(
							"flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
							autoScroll ? "bg-blue-600/20 text-blue-400" : "text-zinc-500 hover:text-zinc-300",
						)}
					>
						<ArrowDown className="w-3 h-3" />
						Auto-scroll
					</button>
				</div>
			</div>

			{/* Log entries */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto font-mono text-xs">
				{filteredLogs.length === 0 ? (
					<div className="text-center py-8 text-zinc-600 text-xs">No log entries</div>
				) : (
					filteredLogs.map((log) => (
						<div
							key={log.id}
							className="flex items-start gap-2 px-3 py-1 hover:bg-zinc-800/30 border-b border-zinc-800/30"
						>
							<span className="text-[10px] text-zinc-600 shrink-0 pt-0.5 w-20">
								{formatTimestamp(log.timestamp).split(", ")[1]}
							</span>
							<span className={cn("text-[10px] uppercase font-bold shrink-0 w-10 pt-0.5", LOG_LEVEL_COLORS[log.level])}>
								{log.level}
							</span>
							{log.nodeName && (
								<span className="text-[10px] text-zinc-600 shrink-0 truncate w-20 pt-0.5">{log.nodeName}</span>
							)}
							<span className="text-zinc-300 break-all flex-1">{log.message}</span>
						</div>
					))
				)}
			</div>
		</div>
	);
}
