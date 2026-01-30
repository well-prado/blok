import { JsonViewer } from "@/components/shared/JsonViewer";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { ExplainError } from "@/components/trace/ExplainError";
import { formatBytes, formatDuration } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { NodeRun, TraceLogEntry } from "@/types";
import { Box, Clock, Code2, Cpu, HardDrive, X } from "lucide-react";

interface NodeDetailProps {
	node: NodeRun;
	logs: TraceLogEntry[];
	onClose: () => void;
}

export function NodeDetail({ node, logs, onClose }: NodeDetailProps) {
	const nodeLogs = logs.filter((l) => l.nodeId === node.id || l.nodeName === node.nodeName);

	return (
		<div className="h-full flex flex-col">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
				<div className="flex items-center gap-2 min-w-0">
					<Box className="w-4 h-4 text-zinc-500 shrink-0" />
					<h3 className="text-sm font-medium text-zinc-100 truncate">{node.nodeName}</h3>
				</div>
				<button
					type="button"
					onClick={onClose}
					className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
					aria-label="Close detail panel"
				>
					<X className="w-4 h-4" />
				</button>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto p-4 space-y-4">
				{/* Status row */}
				<div className="flex items-center gap-3">
					<StatusBadge status={node.status} />
					{node.runtimeKind && (
						<span className="flex items-center gap-1 text-xs text-zinc-500">
							<Code2 className="w-3 h-3" />
							{node.runtimeKind}
						</span>
					)}
					<span className="text-xs text-zinc-600">{node.nodeType}</span>
				</div>

				{/* Metrics */}
				<div className="grid grid-cols-3 gap-2">
					<MetricItem icon={<Clock className="w-3 h-3" />} label="Duration" value={formatDuration(node.durationMs)} />
					{node.metrics?.cpu_ms !== undefined && (
						<MetricItem icon={<Cpu className="w-3 h-3" />} label="CPU" value={formatDuration(node.metrics.cpu_ms)} />
					)}
					{node.metrics?.memory_bytes !== undefined && (
						<MetricItem
							icon={<HardDrive className="w-3 h-3" />}
							label="Memory"
							value={formatBytes(node.metrics.memory_bytes)}
						/>
					)}
				</div>

				{/* Error */}
				{node.error && (
					<div className="rounded-md border border-red-900/50 bg-red-950/30 p-3">
						<div className="flex items-center justify-between mb-1">
							<span className="text-xs font-medium text-red-400">Error</span>
							<ExplainError runId={node.runId} nodeId={node.id} compact />
						</div>
						<p className="text-xs text-red-300 font-mono break-all">{node.error.message}</p>
						{node.error.code && <p className="text-[11px] text-red-400/70 mt-1">Code: {node.error.code}</p>}
						{node.error.stack && (
							<pre className="mt-2 text-[10px] text-red-400/60 overflow-x-auto whitespace-pre-wrap break-all max-h-40">
								{node.error.stack}
							</pre>
						)}
					</div>
				)}

				{/* Input */}
				{node.inputs !== undefined && node.inputs !== null && (
					<Section title="Input">
						<JsonViewer data={node.inputs} defaultExpanded={false} />
					</Section>
				)}

				{/* Output */}
				{node.outputs !== undefined && node.outputs !== null && (
					<Section title="Output">
						<JsonViewer data={node.outputs} defaultExpanded={false} />
					</Section>
				)}

				{/* Logs */}
				{nodeLogs.length > 0 && (
					<Section title={`Logs (${nodeLogs.length})`}>
						<div className="space-y-1 max-h-48 overflow-y-auto">
							{nodeLogs.map((log) => (
								<div key={log.id} className="flex items-start gap-2 text-xs font-mono">
									<span
										className={cn(
											"uppercase text-[10px] font-bold w-10 shrink-0 pt-0.5",
											log.level === "error" && "text-red-400",
											log.level === "warn" && "text-amber-400",
											log.level === "info" && "text-blue-400",
											log.level === "debug" && "text-zinc-500",
										)}
									>
										{log.level}
									</span>
									<span className="text-zinc-300 break-all">{log.message}</span>
								</div>
							))}
						</div>
					</Section>
				)}
			</div>
		</div>
	);
}

function MetricItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
	return (
		<div className="rounded-md bg-zinc-800/50 px-2.5 py-2">
			<div className="flex items-center gap-1 text-zinc-500 mb-0.5">
				{icon}
				<span className="text-[10px]">{label}</span>
			</div>
			<div className="text-xs font-mono text-zinc-200">{value}</div>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div>
			<h4 className="text-xs font-medium text-zinc-500 mb-2">{title}</h4>
			<div className="rounded-md border border-zinc-800 bg-zinc-900 p-3">{children}</div>
		</div>
	);
}
