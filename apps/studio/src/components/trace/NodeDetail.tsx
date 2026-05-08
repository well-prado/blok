import { JsonViewer } from "@/components/shared/JsonViewer";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { BlokErrorDetail } from "@/components/trace/BlokErrorDetail";
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

				{/* v0.5 control-flow primitives — surface per-primitive
				    metadata above input/output so operators can tell what
				    the step actually did at a glance. */}
				{(node.nodeType === "forEach" ||
					node.nodeType === "loop" ||
					node.nodeType === "switch" ||
					node.nodeType === "tryCatch") && <PrimitiveBanner node={node} />}

				{/* Live progress (master plan §17 Phase 5 follow-up) —
				    SDKs that emit `Progress` frames during ExecuteStream
				    drive this bar forward. Always renders the latest
				    snapshot; absent for unary calls + SDKs that don't
				    emit progress. */}
				{node.progress && <ProgressBar percent={node.progress.percent} phase={node.progress.phase} />}

				{/* Live partial result — interim snapshot from a
				    long-running computation (e.g. row count of an
				    in-progress export). Collapsed by default since
				    the snapshot can be large. */}
				{node.partialResult && (
					<details className="text-xs">
						<summary className="cursor-pointer text-zinc-500 hover:text-zinc-300 select-none">
							Partial result <span className="text-zinc-600">(live)</span>
						</summary>
						<div className="mt-2 pl-2 border-l border-zinc-800">
							<JsonViewer data={node.partialResult.snapshot} defaultExpanded={false} />
						</div>
					</details>
				)}

				{/* Error — typed BlokError gets rich rendering (category pill,
				    severity, retryable hint, remediation, doc_url, causes,
				    context snapshot, stack). Untyped errors fall through to
				    the message + stack render inside `BlokErrorDetail`. */}
				{node.error && (
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-xs font-medium text-red-400">Error</span>
							<ExplainError runId={node.runId} nodeId={node.id} compact />
						</div>
						<BlokErrorDetail error={node.error} />
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

/**
 * Live progress bar for the §17 Phase 5 streaming `Progress` frames.
 * Render-only; the parent passes the latest `{percent, phase}` and we
 * project that into a horizontal bar with the phase label inline.
 *
 * Tone: cyan/teal to distinguish from status colors (green/red/amber).
 * Width is the percent value clamped 0–100 to absorb out-of-range
 * frames without breaking the layout.
 */
/**
 * v0.5 — banner that surfaces primitive-specific metadata for forEach /
 * loop / switch / tryCatch nodes. Lives above input/output so operators
 * can read the "what did this step actually do" answer at a glance,
 * without expanding the JSON viewer.
 *
 * Each primitive draws a colour matching its StepRail badge so the eye
 * carries information across the two panels. Information surfaced:
 *
 *   forEach  — iteration count (length of the output array) + concurrency
 *              hint when parallel mode produced fewer iterations than the
 *              cap allows
 *   loop     — descriptive hint (the iteration counter lives on
 *              ctx.state[<id>Index] which Studio can't read directly post-
 *              run, so we link the operator to the inner step rail)
 *   switch   — descriptive hint about first-match-wins semantics
 *   tryCatch — whether `error` field is set on the node (the catch arm
 *              fired) vs successful completion
 */
function PrimitiveBanner({ node }: { node: NodeRun }) {
	const cls = "rounded-md border px-3 py-2 text-xs space-y-1";
	if (node.nodeType === "forEach") {
		const count = Array.isArray(node.outputs) ? node.outputs.length : null;
		return (
			<div className={cn(cls, "border-purple-900/50 bg-purple-950/20 text-purple-200")}>
				<div className="flex items-center gap-2">
					<span className="font-mono text-[10px] uppercase tracking-wide text-purple-300">forEach</span>
					{count !== null && (
						<span className="font-mono text-purple-200/80">
							{count} iteration{count === 1 ? "" : "s"}
						</span>
					)}
				</div>
				<p className="text-purple-200/70 leading-snug">
					Each iteration ran the inner pipeline on a per-item ctx clone — see depth-1 child rows in the rail for the
					per-iteration step traces.
				</p>
			</div>
		);
	}
	if (node.nodeType === "loop") {
		return (
			<div className={cn(cls, "border-blue-900/50 bg-blue-950/20 text-blue-200")}>
				<div className="font-mono text-[10px] uppercase tracking-wide text-blue-300">loop · while-condition</div>
				<p className="text-blue-200/70 leading-snug">
					Ran the inner pipeline while the `while` expression stayed truthy. State mutations carry forward across
					iterations; counter exposed at <code className="font-mono">ctx.state[&lt;id&gt;Index]</code>. Hard
					maxIterations cap throws <code className="font-mono">LoopMaxIterationsError</code>.
				</p>
			</div>
		);
	}
	if (node.nodeType === "switch") {
		return (
			<div className={cn(cls, "border-amber-900/50 bg-amber-950/20 text-amber-200")}>
				<div className="font-mono text-[10px] uppercase tracking-wide text-amber-300">switch · first-match-wins</div>
				<p className="text-amber-200/70 leading-snug">
					Compared <code className="font-mono">on</code> against each <code className="font-mono">when</code> in order;
					first match's inner steps ran (visible as depth-1 children below in the rail). On no match, the optional{" "}
					<code className="font-mono">default</code> block runs instead.
				</p>
			</div>
		);
	}
	if (node.nodeType === "tryCatch") {
		// `node.status` reflects the OUTER tryCatch step's outcome. Completed
		// = either try succeeded or catch handled. Failed = uncaught throw
		// (from catch or finally) propagated past this step.
		const summaryLabel = node.status === "completed" ? "completed" : "propagated";
		return (
			<div className={cn(cls, "border-rose-900/50 bg-rose-950/20 text-rose-200")}>
				<div className="font-mono text-[10px] uppercase tracking-wide text-rose-300">tryCatch · {summaryLabel}</div>
				<p className="text-rose-200/70 leading-snug">
					Try arm ran first; on throw, ctx.error was populated and the catch arm ran. Finally arm runs unconditionally
					(after success, after caught error, AND after an uncaught throw from catch).{" "}
					<code className="font-mono">$.error.message</code> resolves the underlying author-thrown text inside the catch
					arm.
				</p>
			</div>
		);
	}
	return null;
}

function ProgressBar({ percent, phase }: { percent: number; phase: string }) {
	const clamped = Math.max(0, Math.min(100, percent));
	return (
		<div className="rounded-md border border-cyan-900/50 bg-cyan-950/20 p-2.5">
			<div className="flex items-center justify-between mb-1.5 text-[10px]">
				<span className="font-medium uppercase tracking-wider text-cyan-300/80">Progress</span>
				<span className="font-mono text-cyan-200/80">
					{clamped}%{phase ? ` · ${phase}` : ""}
				</span>
			</div>
			<div className="h-1.5 rounded-full overflow-hidden bg-cyan-950/60">
				<div className="h-full bg-cyan-500/70 transition-all duration-200" style={{ width: `${clamped}%` }} />
			</div>
		</div>
	);
}
