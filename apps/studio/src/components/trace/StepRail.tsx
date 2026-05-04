import { STATUS_DOT_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { NodeRun } from "@/types";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";

/**
 * Left-pane vertical step list — Direction A's persistent answer to
 * "where in the run am I?". Click jumps the active step. j/k cycles.
 * Always visible regardless of which center-pane mode is on, so the
 * spatial frame stays put across mode switches.
 *
 * Each row: idx · status dot · name · duration. Active row gets the
 * brand-green left edge bar + tinted background (matches Sidebar's
 * active-link pattern, intentionally — same visual rhythm everywhere).
 *
 * Virtualized with `@tanstack/react-virtual` once the run has more
 * than 50 steps. Below that threshold the non-virtualized path is
 * cheaper (avoids the wrapper div + position math) and indistinguishable
 * to the operator. The fixed row height of 30px corresponds to
 * `py-1.5 + text-[12.5px]` and is what `estimateSize` returns; small
 * variance from longer names is absorbed by overscan + the `dynamic`
 * mode is unnecessary.
 */
type Props = {
	nodes: NodeRun[];
	activeStepId: string | null;
	onSelect: (id: string) => void;
};

const VIRTUALIZE_THRESHOLD = 50;
const ROW_HEIGHT = 30;

export function StepRail({ nodes, activeStepId, onSelect }: Props) {
	const sorted = useMemo(() => nodes.slice().sort((a, b) => a.stepIndex - b.stepIndex), [nodes]);
	const completed = nodes.filter((n) => n.status === "completed").length;
	const failed = nodes.filter((n) => n.status === "failed").length;
	const running = nodes.filter((n) => n.status === "running").length;

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const useVirtual = sorted.length >= VIRTUALIZE_THRESHOLD;

	const virtualizer = useVirtualizer({
		count: useVirtual ? sorted.length : 0,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 8,
	});

	const renderRow = (n: NodeRun, isActive: boolean) => (
		<button
			type="button"
			onClick={() => onSelect(n.id)}
			// Inline padding for nested flow children — Tailwind can't
			// generate dynamic `pl-${expr}` at build time.
			style={n.depth > 0 ? { paddingLeft: `${16 + n.depth * 12}px` } : undefined}
			className={cn(
				"relative w-full flex items-center gap-2.5 pl-4 pr-3 py-1.5 text-[12.5px] cursor-pointer transition-colors text-left",
				isActive
					? "bg-blok-green-500/10 text-zinc-100 before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:bg-blok-green-500 before:rounded-r"
					: "text-zinc-400 hover:bg-hover hover:text-zinc-200",
			)}
		>
			<span className="font-mono text-[10px] text-zinc-600 w-3 shrink-0">{n.stepIndex + 1}</span>
			<span
				className={cn(
					"w-1.5 h-1.5 rounded-full shrink-0 transition-status",
					STATUS_DOT_COLORS[n.status],
					n.status === "running" && "animate-pulse-dot",
				)}
			/>
			<span className="flex-1 truncate">{n.nodeName}</span>
			{/* Tier 2: sub-workflow indicator — `↳ sub` (sync) or `↳ async`
			    (fire-and-forget). Drill into the child via the "Sub-runs"
			    strip in the run header. PR 5 E3 — append depth count
			    when nested (depth >= 2) so operators see "↳ sub (3)" for
			    a third-level nested invocation. */}
			{n.nodeType === "subworkflow" && (
				<span
					className={cn(
						"font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded shrink-0",
						n.wait === false ? "bg-orange-300/15 text-orange-300" : "bg-zinc-700/40 text-zinc-300",
					)}
					title={
						n.wait === false
							? `Async sub-workflow (fire-and-forget) — child runs independently; parent does NOT block${
									n.subworkflowDepth && n.subworkflowDepth >= 2 ? ` · nested at depth ${n.subworkflowDepth}` : ""
								}`
							: `Sub-workflow invocation (synchronous) — see Sub-runs in the header${
									n.subworkflowDepth && n.subworkflowDepth >= 2 ? ` · nested at depth ${n.subworkflowDepth}` : ""
								}`
					}
				>
					{n.wait === false ? "↳ async" : "↳ sub"}
					{n.subworkflowDepth && n.subworkflowDepth >= 2 ? ` (${n.subworkflowDepth})` : ""}
				</span>
			)}
			{/* PR 4: wait.for / wait.until step — workflow paused at this
			    step, resumes when the deadline fires. */}
			{n.nodeType === "wait" && (
				<span
					className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-cyan-300/15 text-cyan-300 shrink-0"
					title="Wait step — workflow paused until the deadline fires"
				>
					↳ wait
				</span>
			)}
			{/* Tier 1: CACHED badge — node short-circuited via the idempotency cache. */}
			{n.cached && (
				<span
					className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-blok-green-500/15 text-blok-green-500 shrink-0"
					title={`Reused result from run ${n.cached.sourceRunId}`}
				>
					cached
				</span>
			)}
			{/* Tier 1: retry indicator — node had at least one failed attempt before final outcome. */}
			{n.attempts && n.attempts.length > 0 && (
				<span
					className="font-mono text-[9px] px-1 py-px rounded bg-status-warning/15 text-status-warning shrink-0"
					title={`${n.attempts.length} failed attempt${n.attempts.length === 1 ? "" : "s"} before outcome`}
				>
					↻{n.attempts.length}
				</span>
			)}
			{n.durationMs != null && (
				<span
					className={cn(
						"font-mono text-[10.5px] shrink-0",
						n.status === "failed" ? "text-status-failed" : isActive ? "text-zinc-300" : "text-zinc-600",
					)}
				>
					{n.durationMs < 1000 ? `${n.durationMs} ms` : `${(n.durationMs / 1000).toFixed(2)} s`}
				</span>
			)}
		</button>
	);

	return (
		<aside ref={scrollRef} className="h-full bg-canvas border-r border-zinc-800 overflow-y-auto py-2">
			{/* Header */}
			<div className="px-4 pt-2 pb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold">
				<span>Steps</span>
				<span
					className={cn("font-mono normal-case tracking-normal", failed > 0 ? "text-status-failed" : "text-zinc-400")}
				>
					{failed > 0 ? `${failed} failed` : `${completed} / ${nodes.length}`}
					{running > 0 && <span className="text-status-running"> · {running} running</span>}
				</span>
			</div>

			{/* Rows: non-virtualized for short runs, virtualized for long. */}
			{!useVirtual ? (
				<ul className="mt-1">
					{sorted.map((n) => (
						<li key={n.id}>{renderRow(n, n.id === activeStepId)}</li>
					))}
				</ul>
			) : (
				<ul
					className="relative mt-1 list-none p-0 m-0"
					style={{ height: `${virtualizer.getTotalSize()}px` }}
					aria-label={`${sorted.length} steps`}
				>
					{virtualizer.getVirtualItems().map((vi) => {
						const n = sorted[vi.index];
						if (!n) return null;
						return (
							<li
								key={n.id}
								className="absolute left-0 right-0"
								style={{ top: 0, transform: `translateY(${vi.start}px)`, height: `${vi.size}px` }}
							>
								{renderRow(n, n.id === activeStepId)}
							</li>
						);
					})}
				</ul>
			)}
		</aside>
	);
}
