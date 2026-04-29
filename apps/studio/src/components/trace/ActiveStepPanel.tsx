import { JsonViewer } from "@/components/shared/JsonViewer";
import { BlokErrorFrame } from "@/components/trace/BlokErrorFrame";
import { cn } from "@/lib/utils";
import type { NodeRun, TraceLogEntry } from "@/types";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Center-pane "Active step" view (Direction A · Phase 1.3).
 *
 * Replaces the old NodeDetail-as-drawer with a proper page-grade layout:
 * a tight header (status badge + step name + transport pills + position
 * breadcrumb), then either the BlokErrorFrame (when the step failed —
 * error becomes the page topic) or three collapsible sections
 * (Inputs / Outputs / Logs). Default expansion: Inputs and Outputs open,
 * Logs closed (so the panel doesn't whirr through 200 log lines on
 * every step click). Toggling re-opens the same set on the next step
 * because section state lives in this component, scoped per node id —
 * intentional, lets operators establish a viewing habit.
 *
 * The Inspector (right pane) still owns the dense numbers (wall, wire,
 * cpu, memory) — this panel keeps the spotlight on what the step *did*,
 * not what it cost. One purpose per pane.
 */
type Props = {
	node: NodeRun;
	logs: TraceLogEntry[];
	totalSteps: number;
	transport?: string;
};

export function ActiveStepPanel({ node, logs, totalSteps, transport }: Props) {
	// Per-node section open-state. Resets when the active node changes
	// because operators usually want a clean view per step.
	const [openSections, setOpenSections] = useState({
		input: true,
		output: true,
		logs: false,
		live: true,
	});

	// Reset on node change
	// biome-ignore lint/correctness/useExhaustiveDependencies: node.id is the trigger — biome can't tell that re-running on id change is the intent.
	useEffect(() => {
		setOpenSections({ input: true, output: true, logs: false, live: true });
	}, [node.id]);

	const nodeLogs = logs.filter((l) => l.nodeId === node.id || l.nodeName === node.nodeName);
	const isError = !!node.error;
	const transportLabel = transport ?? inferTransport(node);

	return (
		<div className="h-full flex flex-col">
			{/* ── Header ───────────────────────────────────────────────── */}
			<header className="px-8 pt-5 pb-3 border-b border-zinc-800 bg-canvas">
				<div className="flex items-baseline gap-3 mb-2">
					<StatusDot status={node.status} />
					<h2 className="font-mono text-[18px] font-medium text-zinc-100 tracking-tight truncate">{node.nodeName}</h2>
					<span className="font-mono text-[11.5px] text-zinc-500 shrink-0">
						step {node.stepIndex + 1} / {totalSteps}
						{node.depth > 0 && <span className="text-zinc-600"> · depth {node.depth}</span>}
					</span>
				</div>
				<div className="flex items-center flex-wrap gap-1.5 ml-5">
					<MetaPill>{node.nodeType}</MetaPill>
					{transportLabel && <MetaPill accent>{transportLabel}</MetaPill>}
					{node.runtimeKind && <MetaPill>{node.runtimeKind}</MetaPill>}
					{node.metrics?.request_bytes != null && (
						<MetaPill>
							<span className="text-zinc-500">req</span> {fmtBytes(node.metrics.request_bytes)}
						</MetaPill>
					)}
				</div>
			</header>

			{/* ── Body ─────────────────────────────────────────────────── */}
			<div className="flex-1 overflow-y-auto">
				{/* Live progress (Phase 5 streaming) — sits above content
				    when the SDK is still emitting frames. */}
				{node.progress && (
					<div className="px-8 pt-5">
						<ProgressBar percent={node.progress.percent} phase={node.progress.phase} />
					</div>
				)}

				{/* Live partial result */}
				{node.partialResult && (
					<div className="px-8 pt-5">
						<Section
							title="Partial result"
							subtitle="live"
							open={openSections.live}
							onToggle={() => setOpenSections((s) => ({ ...s, live: !s.live }))}
						>
							<JsonViewer data={node.partialResult.snapshot} defaultExpanded={false} />
						</Section>
					</div>
				)}

				{/* Error gets the page-topic frame (the redesign signature) */}
				{isError && node.error && (
					<BlokErrorFrame
						error={node.error}
						stepName={node.nodeName}
						stepIndex={node.stepIndex}
						totalSteps={totalSteps}
						runtimeKind={node.runtimeKind}
						transport={transportLabel}
						finishedAt={node.finishedAt}
						runId={node.runId}
						nodeId={node.id}
					/>
				)}

				{/* Success path: inputs · outputs · logs */}
				{!isError && (
					<div className="px-8 py-5 space-y-5">
						{node.inputs !== undefined && node.inputs !== null && (
							<Section
								title="Input"
								subtitle={summarizeShape(node.inputs)}
								open={openSections.input}
								onToggle={() => setOpenSections((s) => ({ ...s, input: !s.input }))}
							>
								<JsonViewer data={node.inputs} defaultExpanded={false} />
							</Section>
						)}
						{node.outputs !== undefined && node.outputs !== null && (
							<Section
								title="Output"
								subtitle={summarizeShape(node.outputs)}
								open={openSections.output}
								onToggle={() => setOpenSections((s) => ({ ...s, output: !s.output }))}
							>
								<JsonViewer data={node.outputs} defaultExpanded={false} />
							</Section>
						)}
						{nodeLogs.length > 0 && (
							<Section
								title="Logs"
								subtitle={`${nodeLogs.length} ${nodeLogs.length === 1 ? "entry" : "entries"}`}
								open={openSections.logs}
								onToggle={() => setOpenSections((s) => ({ ...s, logs: !s.logs }))}
							>
								<div className="font-mono text-[11.5px] leading-relaxed max-h-72 overflow-y-auto">
									{nodeLogs.map((log) => (
										<div
											key={log.id}
											className="grid grid-cols-[88px_56px_1fr] gap-3 py-1 border-b border-zinc-800 last:border-b-0"
										>
											<span className="text-zinc-500">{new Date(log.timestamp).toISOString().slice(11, 23)}</span>
											<span
												className={cn(
													"uppercase text-[10px] tracking-[0.05em] font-semibold",
													log.level === "info" && "text-log-info",
													log.level === "warn" && "text-log-warn",
													log.level === "error" && "text-log-error",
													log.level === "debug" && "text-log-debug",
												)}
											>
												{log.level}
											</span>
											<span className="text-zinc-200 break-words">{log.message}</span>
										</div>
									))}
								</div>
							</Section>
						)}

						{/* Empty-stage hint when the step has nothing to show
						    (no inputs, no outputs, no logs). Better than a
						    silent empty pane. */}
						{(node.inputs == null || node.inputs === undefined) &&
							(node.outputs == null || node.outputs === undefined) &&
							nodeLogs.length === 0 && (
								<p className="text-[12px] text-zinc-500 py-8 text-center">
									This step ran cleanly with no captured inputs, outputs, or logs.
								</p>
							)}
					</div>
				)}
			</div>
		</div>
	);
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Section({
	title,
	subtitle,
	open,
	onToggle,
	children,
}: {
	title: string;
	subtitle?: string;
	open: boolean;
	onToggle: () => void;
	children: React.ReactNode;
}) {
	return (
		<div>
			<button
				type="button"
				onClick={onToggle}
				className="w-full flex items-center gap-2 py-1.5 text-[11px] uppercase tracking-[0.08em] text-zinc-500 hover:text-zinc-300 font-semibold transition-colors"
			>
				<ChevronRight className={cn("w-3 h-3 transition-transform shrink-0", open && "rotate-90")} />
				<span>{title}</span>
				{subtitle && (
					<span className="text-[11px] normal-case tracking-normal text-zinc-600 font-normal ml-auto">{subtitle}</span>
				)}
			</button>
			{open && <div className="mt-1.5 rounded-md border border-zinc-800 bg-overlay px-4 py-3">{children}</div>}
		</div>
	);
}

function MetaPill({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
	return (
		<span
			className={cn(
				"font-mono text-[11px] px-2 py-0.5 rounded-full border",
				accent
					? "bg-blok-green-500/10 text-blok-green-500 border-blok-green-500/25"
					: "bg-raised text-zinc-400 border-zinc-800",
			)}
		>
			{children}
		</span>
	);
}

function StatusDot({ status }: { status: NodeRun["status"] }) {
	const cls: Record<NodeRun["status"], string> = {
		pending: "bg-status-pending",
		running: "bg-status-running animate-pulse-dot",
		completed: "bg-status-completed",
		failed: "bg-status-failed",
		skipped: "bg-status-skipped",
	};
	return <span className={cn("w-2 h-2 rounded-full shrink-0 translate-y-px", cls[status])} />;
}

/** Heuristic infer transport from node type. Caller can override. */
function inferTransport(node: NodeRun): string | undefined {
	if (node.nodeType === "module" || node.nodeType === "local") return "module";
	if (node.nodeType?.startsWith("runtime.")) return "grpc";
	return undefined;
}

function summarizeShape(value: unknown): string {
	if (value == null) return "null";
	if (typeof value !== "object") return typeof value;
	if (Array.isArray(value)) {
		return `${value.length} ${value.length === 1 ? "item" : "items"}`;
	}
	const keys = Object.keys(value as Record<string, unknown>);
	return `${keys.length} ${keys.length === 1 ? "key" : "keys"}`;
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Streaming-progress bar — kept here because it's a step-level concern. */
function ProgressBar({ percent, phase }: { percent: number; phase: string }) {
	const clamped = Math.max(0, Math.min(100, percent));
	return (
		<div className="rounded-md border border-blok-green-500/20 bg-blok-green-500/5 px-3 py-2 mb-1">
			<div className="flex items-center justify-between mb-1.5 text-[10px]">
				<span className="font-medium uppercase tracking-[0.08em] text-blok-green-500">Progress</span>
				<span className="font-mono text-zinc-300">
					{clamped}%{phase ? ` · ${phase}` : ""}
				</span>
			</div>
			<div className="h-1 rounded-full overflow-hidden bg-zinc-800">
				<div className="h-full bg-blok-green-500 transition-all duration-200" style={{ width: `${clamped}%` }} />
			</div>
		</div>
	);
}
