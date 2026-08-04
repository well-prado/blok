import { StatusBadge } from "@/components/shared/StatusBadge";
import { NodeDetail } from "@/components/trace/NodeDetail";
import { formatBytes } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { BrowserArtifact, NodeRun, TraceLogEntry } from "@/types";
import { FileCheck2, Images, ListTree, ScrollText } from "lucide-react";
import { useState } from "react";

type DrawerTab = "details" | "logs" | "assertions" | "artifacts";

interface ActivityDrawerProps {
	nodes: NodeRun[];
	logs: TraceLogEntry[];
	stepUses: Record<string, string>;
	selectedNodeId: string | null;
	selectedArtifactId?: string;
	onSelectNode: (nodeId: string | null) => void;
	onSelectArtifact: (artifact: BrowserArtifact, nodeId: string) => void;
}

export function ActivityDrawer({
	nodes,
	logs,
	stepUses,
	selectedNodeId,
	selectedArtifactId,
	onSelectNode,
	onSelectArtifact,
}: ActivityDrawerProps) {
	const [tab, setTab] = useState<DrawerTab>("details");
	const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
	const assertions = nodes.filter((node) => stepUses[node.nodeName]?.startsWith("@blokjs/browser-assert-"));
	const artifacts = nodes.flatMap((node) => (node.artifacts ?? []).map((artifact) => ({ artifact, node })));
	const tabs = [
		{ key: "details" as const, label: "Details", count: selectedNode ? 1 : 0, icon: ListTree },
		{ key: "logs" as const, label: "Logs", count: logs.length, icon: ScrollText },
		{ key: "assertions" as const, label: "Assertions", count: assertions.length, icon: FileCheck2 },
		{ key: "artifacts" as const, label: "Artifacts", count: artifacts.length, icon: Images },
	];

	return (
		<section className="border-t border-zinc-800 bg-zinc-950" aria-label="Run activity">
			<nav className="flex h-10 items-center gap-1 border-b border-zinc-800 px-3" aria-label="Activity tabs">
				{tabs.map(({ key, label, count, icon: Icon }) => (
					<button
						type="button"
						key={key}
						onClick={() => setTab(key)}
						className={cn(
							"inline-flex h-full items-center gap-1.5 border-b-2 px-2 text-xs font-medium",
							tab === key
								? "border-blok-green-500 text-zinc-100"
								: "border-transparent text-zinc-500 hover:text-zinc-300",
						)}
					>
						<Icon className="h-3.5 w-3.5" /> {label}
						<span className="rounded-full bg-zinc-800 px-1.5 font-mono text-[9px] text-zinc-400">{count}</span>
					</button>
				))}
			</nav>

			<div className="h-72 overflow-y-auto">
				{tab === "details" &&
					(selectedNode ? (
						<NodeDetail node={selectedNode} logs={logs} onClose={() => onSelectNode(null)} />
					) : (
						<EmptyState>Select a canvas step to inspect its live inputs, output, logs, and screenshots.</EmptyState>
					))}

				{tab === "logs" && (
					<div className="space-y-1 p-3 font-mono text-[11px]">
						{logs.length === 0 ? (
							<EmptyState>No logs have been emitted by this run.</EmptyState>
						) : (
							logs.slice(-100).map((log) => (
								<button
									type="button"
									key={log.id}
									onClick={() => {
										if (log.nodeId) onSelectNode(log.nodeId);
									}}
									className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-zinc-900"
								>
									<span className="shrink-0 text-zinc-600">{new Date(log.timestamp).toISOString().slice(11, 23)}</span>
									<span
										className={cn(
											"w-10 shrink-0 uppercase",
											log.level === "error" && "text-red-400",
											log.level === "warn" && "text-amber-400",
											log.level === "info" && "text-blue-400",
											log.level === "debug" && "text-zinc-500",
										)}
									>
										{log.level}
									</span>
									<span className="text-zinc-300">{log.message}</span>
									<span className="ml-auto shrink-0 text-zinc-600">{log.nodeName}</span>
								</button>
							))
						)}
					</div>
				)}

				{tab === "assertions" && (
					<div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
						{assertions.length === 0 ? (
							<EmptyState>No browser assertions have executed.</EmptyState>
						) : (
							assertions.map((node) => {
								const detail = assertionDetail(node);
								return (
									<button
										type="button"
										key={node.id}
										onClick={() => {
											onSelectNode(node.id);
											setTab("details");
										}}
										className="rounded-md border border-zinc-800 bg-zinc-900 p-3 text-left hover:border-zinc-700"
									>
										<div className="mb-2 flex items-center justify-between gap-2">
											<span className="truncate text-xs font-medium text-zinc-200">{node.nodeName}</span>
											<StatusBadge status={node.status} />
										</div>
										<div className="space-y-1 font-mono text-[10px]">
											<div className="text-zinc-500">expected · {formatValue(detail.expected)}</div>
											<div className={node.status === "failed" ? "text-red-300" : "text-green-300"}>
												actual · {formatValue(detail.actual)}
											</div>
										</div>
									</button>
								);
							})
						)}
					</div>
				)}

				{tab === "artifacts" && (
					<div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
						{artifacts.length === 0 ? (
							<EmptyState>No screenshots or browser artifacts have been recorded.</EmptyState>
						) : (
							artifacts.map(({ artifact, node }) => (
								<button
									type="button"
									key={artifact.id}
									onClick={() => onSelectArtifact(artifact, node.id)}
									className={cn(
										"overflow-hidden rounded-md border bg-zinc-900 text-left hover:border-zinc-600",
										selectedArtifactId === artifact.id ? "border-cyan-400" : "border-zinc-800",
									)}
								>
									{artifact.kind === "screenshot" && (
										<img
											src={artifact.url}
											alt={artifact.name}
											loading="lazy"
											className="aspect-video w-full object-cover object-top"
										/>
									)}
									<div className="flex items-center gap-2 px-2 py-1.5 font-mono text-[10px]">
										<span className="min-w-0 flex-1 truncate text-zinc-300">{artifact.name}</span>
										<span className="text-zinc-600">{formatBytes(artifact.size)}</span>
									</div>
									<div className="truncate border-t border-zinc-800 px-2 py-1 text-[9px] text-zinc-600">
										{node.nodeName}
									</div>
								</button>
							))
						)}
					</div>
				)}
			</div>
		</section>
	);
}

function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<div className="col-span-full flex h-full items-center justify-center p-8 text-xs text-zinc-600">{children}</div>
	);
}

function assertionDetail(node: NodeRun): { expected?: unknown; actual?: unknown } {
	const output = asRecord(node.outputs);
	const data = asRecord(output?.data) ?? output;
	const details = asRecord(node.error?.details);
	return { expected: data?.expected ?? details?.expected, actual: data?.actual ?? details?.actual };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function formatValue(value: unknown): string {
	if (value === undefined) return "—";
	return typeof value === "string" ? value : JSON.stringify(value);
}
