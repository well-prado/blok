import { DurationBadge } from "@/components/shared/DurationBadge";
import { EmptyState } from "@/components/shared/EmptyState";
import { ExportMenu } from "@/components/shared/ExportMenu";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TagEditor } from "@/components/shared/TagEditor";
import { ActiveStepPanel } from "@/components/trace/ActiveStepPanel";
import { EventLog } from "@/components/trace/EventLog";
import { ExplainError } from "@/components/trace/ExplainError";
import { Inspector } from "@/components/trace/Inspector";
import { LogViewer } from "@/components/trace/LogViewer";
import { RequestBuilder } from "@/components/trace/RequestBuilder";
import { StepRail } from "@/components/trace/StepRail";
import { TraceGraph } from "@/components/trace/TraceGraph";
import { useRunDetail, useSubRuns, useTraceStream } from "@/hooks/useRunDetail";
import { exportRunCsv, exportRunJson, replayRun } from "@/lib/api";
import { formatTimestamp } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Activity, ArrowLeft, GitBranch, Loader2, RotateCcw, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * Run-detail · 3-pane operator layout (Direction A · Phase 1).
 *
 * StepRail (240px) | center pane (fluid) | Inspector (320px).
 *
 * The center pane swaps modes via 1-5 (active-step / graph / logs /
 * events / replay) without rebuilding the rail or inspector — the
 * spatial frame stays stable, which is the whole point of moving away
 * from the previous tabs+drawer layout.
 *
 * Default mode = "step" (active-step view). Step selection: defaults
 * to the failed node if any, otherwise the running one, otherwise the
 * first node — so the inspector always has something to render.
 */
export const Route = createFileRoute("/runs/$runId")({
	component: RunTracePage,
});

type Mode = "step" | "graph" | "logs" | "events" | "request";

function RunTracePage() {
	const { runId } = Route.useParams();
	const navigate = useNavigate();
	const { data, isLoading, error } = useRunDetail(runId);
	const [activeStepId, setActiveStepId] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>("step");
	const [replaying, setReplaying] = useState(false);
	const [replayError, setReplayError] = useState<string | null>(null);

	// SSE
	useTraceStream(runId);
	// Tier 2 sub-workflow lineage — fetch this run's children (if any).
	const { data: subRuns } = useSubRuns(runId);

	// Default-select a step so the rail + inspector are never empty when
	// the run has any nodes. Priority: failed > running > first.
	useEffect(() => {
		if (activeStepId || !data || data.nodes.length === 0) return;
		const failed = data.nodes.find((n) => n.status === "failed");
		const running = data.nodes.find((n) => n.status === "running");
		const first = data.nodes.slice().sort((a, b) => a.stepIndex - b.stepIndex)[0];
		const target = failed ?? running ?? first;
		if (target) setActiveStepId(target.id);
	}, [data, activeStepId]);

	// Keyboard nav
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (
				e.target instanceof HTMLInputElement ||
				e.target instanceof HTMLSelectElement ||
				e.target instanceof HTMLTextAreaElement
			) {
				return;
			}
			if (e.metaKey || e.ctrlKey) return;

			// j/k → next/prev step
			if ((e.key === "j" || e.key === "k") && data) {
				e.preventDefault();
				const sorted = data.nodes.slice().sort((a, b) => a.stepIndex - b.stepIndex);
				if (sorted.length === 0) return;
				const idx = sorted.findIndex((n) => n.id === activeStepId);
				const nextIdx = e.key === "j" ? Math.min(idx + 1, sorted.length - 1) : Math.max(idx - 1, 0);
				const target = sorted[nextIdx];
				if (target) setActiveStepId(target.id);
				return;
			}

			// 1-5 → mode switch
			switch (e.key) {
				case "1":
					setMode("step");
					break;
				case "2":
					setMode("graph");
					break;
				case "3":
					setMode("logs");
					break;
				case "4":
					setMode("events");
					break;
				case "5":
					setMode("request");
					break;
				case "Escape":
					setMode("step");
					break;
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [data, activeStepId]);

	const activeNode = useMemo(() => {
		if (!data || !activeStepId) return null;
		return data.nodes.find((n) => n.id === activeStepId) || null;
	}, [data, activeStepId]);

	const nodeNames = useMemo(() => {
		if (!data) return [];
		return [...new Set(data.nodes.map((n) => n.nodeName))];
	}, [data]);

	const triggerParts = useMemo(() => {
		if (!data) return { method: "GET", path: "/" };
		const parts = data.run.triggerSummary.split(" ");
		return { method: parts[0] || "GET", path: parts[1] || "/" };
	}, [data]);

	const handleReplay = async () => {
		if (!data || replaying) return;
		setReplaying(true);
		setReplayError(null);
		try {
			const result = await replayRun(runId);
			navigate({ to: "/runs/$runId", params: { runId: result.newRunId } });
		} catch (err) {
			setReplayError(err instanceof Error ? err.message : "Replay failed");
		} finally {
			setReplaying(false);
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
			</div>
		);
	}

	if (error || !data) {
		return (
			<div className="p-6">
				<EmptyState
					icon={<Activity className="w-12 h-12" />}
					title="Run not found"
					description={`No run with ID "${runId}" was found.`}
				/>
			</div>
		);
	}

	const { run, nodes, logs } = data;
	const isHttpTrigger = run.triggerType === "http";
	const isFinished = run.status === "completed" || run.status === "failed" || run.status === "cancelled";

	const modes: { key: Mode; label: string; show: boolean }[] = [
		{ key: "step", label: "Active step", show: true },
		{ key: "graph", label: "Graph", show: true },
		{ key: "logs", label: "Logs", show: true },
		{ key: "events", label: "Events", show: true },
		{ key: "request", label: "Replay", show: isHttpTrigger },
	];

	return (
		<div className="h-full flex flex-col">
			{/* Header */}
			<header className="shrink-0 border-b border-zinc-800 bg-canvas/60 px-4 py-3">
				<div className="flex items-center gap-3 mb-1">
					<Link
						to="/workflows/$name"
						params={{ name: run.workflowName }}
						className="p-1 rounded hover:bg-hover text-zinc-500 hover:text-zinc-300 transition-colors"
					>
						<ArrowLeft className="w-4 h-4" />
					</Link>
					<span className="text-sm text-zinc-500">{run.workflowName}</span>
					<span className="text-zinc-700">/</span>
					<span className="text-sm font-mono text-zinc-400">{run.id.slice(0, 12)}</span>
					<StatusBadge status={run.status} />
					<DurationBadge
						ms={run.status === "running" ? run.startedAt : run.durationMs}
						running={run.status === "running"}
					/>
					{run.replayOf && (
						<Link
							to="/runs/$runId"
							params={{ runId: run.replayOf }}
							className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-raised text-zinc-400 hover:text-zinc-100 hover:bg-hover transition-colors"
							title={`Replay of run ${run.replayOf}`}
						>
							<RotateCcw className="w-2.5 h-2.5" />
							replay of {run.replayOf.slice(0, 8)}
						</Link>
					)}
					{run.parentRunId && (
						<Link
							to="/runs/$runId"
							params={{ runId: run.parentRunId }}
							className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-raised text-zinc-400 hover:text-zinc-100 hover:bg-hover transition-colors"
							title={`Called from run ${run.parentRunId}`}
						>
							<GitBranch className="w-2.5 h-2.5" />
							called from {run.parentRunId.slice(0, 8)}
						</Link>
					)}

					<div className="ml-auto flex items-center gap-2">
						{isFinished && isHttpTrigger && (
							<button
								type="button"
								onClick={handleReplay}
								disabled={replaying}
								className={cn(
									"flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
									replaying
										? "bg-raised text-zinc-500 cursor-not-allowed"
										: "bg-raised text-zinc-300 hover:bg-hover hover:text-zinc-100",
								)}
								title="Replay this run with the same request"
							>
								{replaying ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
								Replay
							</button>
						)}
						{isHttpTrigger && (
							<button
								type="button"
								onClick={() => setMode("request")}
								className={cn(
									"flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
									mode === "request"
										? "bg-blok-green-500/15 text-blok-green-500"
										: "bg-raised text-zinc-300 hover:bg-hover hover:text-zinc-100",
								)}
								title="Open request builder"
							>
								<Send className="w-3 h-3" />
								Request
							</button>
						)}
						{run.status === "failed" && run.error && <ExplainError runId={runId} />}
						<ExportMenu onExportJson={() => exportRunJson(runId)} onExportCsv={() => exportRunCsv(runId)} />
					</div>
				</div>

				<div className="flex items-center gap-4 text-xs text-zinc-500 ml-9">
					<span>
						Trigger: <span className="text-zinc-400 font-mono">{run.triggerSummary}</span>
					</span>
					<span>
						Started: <span className="text-zinc-400">{formatTimestamp(run.startedAt)}</span>
					</span>
					<span>
						Nodes:{" "}
						<span className="text-zinc-400">
							{run.completedNodes}/{run.nodeCount}
						</span>
					</span>
					{replayError && <span className="text-red-400">{replayError}</span>}
				</div>
				<div className="ml-9 mt-1">
					<TagEditor runId={run.id} tags={run.tags || []} />
				</div>
				{subRuns && subRuns.length > 0 && (
					<div className="ml-9 mt-2 flex items-center gap-2 text-[11px] text-zinc-500 flex-wrap">
						<span className="flex items-center gap-1 uppercase tracking-wide font-semibold text-zinc-500">
							<GitBranch className="w-3 h-3" />
							sub-runs ({subRuns.length})
						</span>
						{subRuns.map((sub) => (
							<Link
								key={sub.id}
								to="/runs/$runId"
								params={{ runId: sub.id }}
								className="flex items-center gap-1.5 px-1.5 py-0.5 rounded font-mono bg-raised hover:bg-hover text-zinc-400 hover:text-zinc-100 transition-colors"
								title={`${sub.workflowName} · ${sub.status}`}
							>
								<span
									className={cn(
										"w-1.5 h-1.5 rounded-full shrink-0",
										sub.status === "completed" && "bg-green-500",
										sub.status === "failed" && "bg-red-500",
										sub.status === "running" && "bg-blue-500 animate-pulse",
										sub.status === "cancelled" && "bg-zinc-500",
										sub.status === "pending" && "bg-zinc-600",
									)}
								/>
								{sub.workflowName}
								<span className="text-zinc-600">{sub.id.slice(0, 8)}</span>
							</Link>
						))}
					</div>
				)}
			</header>

			{/* 3-pane shell */}
			<div className="flex-1 grid grid-cols-[240px_minmax(0,1fr)_320px] overflow-hidden">
				{/* Left: step rail */}
				<StepRail nodes={nodes} activeStepId={activeStepId} onSelect={setActiveStepId} />

				{/* Center: mode-switched content */}
				<main className="flex flex-col overflow-hidden bg-canvas">
					{/* Mode tab strip — sticky so it never scrolls away */}
					<nav className="flex gap-0 border-b border-zinc-800 px-4 sticky top-0 bg-canvas z-10">
						{modes
							.filter((m) => m.show)
							.map((m, i) => (
								<button
									type="button"
									key={m.key}
									onClick={() => setMode(m.key)}
									className={cn(
										"px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5",
										mode === m.key
											? "border-blok-green-500 text-zinc-100"
											: "border-transparent text-zinc-500 hover:text-zinc-300",
									)}
								>
									{m.label}
									<kbd className="font-mono text-[9.5px] px-1 py-px rounded bg-raised border border-zinc-800 text-zinc-500">
										{i + 1}
									</kbd>
								</button>
							))}
					</nav>

					{/* Mode content */}
					<div className="flex-1 overflow-y-auto">
						{mode === "step" &&
							(activeNode ? (
								<ActiveStepPanel node={activeNode} logs={logs} totalSteps={nodes.length} />
							) : (
								<div className="p-8 text-sm text-zinc-500">No step selected.</div>
							))}
						{mode === "graph" && (
							<div className="p-4 h-full">
								<TraceGraph run={run} nodes={nodes} selectedNodeId={activeStepId} onSelectNode={setActiveStepId} />
							</div>
						)}
						{mode === "logs" && (
							<div className="h-full">
								<LogViewer logs={logs} nodeNames={nodeNames} />
							</div>
						)}
						{mode === "events" && (
							<div className="p-4">
								<EventLog runId={runId} />
							</div>
						)}
						{mode === "request" && (
							<RequestBuilder
								defaultMethod={triggerParts.method}
								defaultPath={triggerParts.path}
								onClose={() => setMode("step")}
							/>
						)}
					</div>
				</main>

				{/* Right: inspector — wire metrics + live tail */}
				<Inspector node={activeNode} logs={logs} />
			</div>
		</div>
	);
}
