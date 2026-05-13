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

/**
 * v0.5.3 — virtual "iteration N" header row inserted between consecutive
 * sibling NodeRuns that share an iterationIndex. Lets a 5-iteration forEach
 * with 3 inner steps render as 5 collapsible groups instead of 15 flat
 * rows with duplicate names. Same fixed row height as a NodeRun row so
 * virtualization math stays simple.
 */
type IterationHeaderItem = {
	kind: "iteration-header";
	key: string;
	iterIndex: number;
	depth: number;
};

type NodeRowItem = {
	kind: "node";
	node: NodeRun;
};

export type RailItem = IterationHeaderItem | NodeRowItem;

/**
 * Walk the sorted node list and synthesize iteration headers wherever
 * `iterationIndex` transitions between consecutive sibling rows.
 *
 * Algorithm: maintain a per-depth memo of the most recent iterationIndex
 * seen at that depth. When we hit a row at depth D whose iterationIndex
 * differs from the memo[D], emit a header. When we transition to a
 * shallower depth, invalidate memo entries for deeper depths so a
 * subsequent same-depth row is treated as a fresh iteration scope.
 *
 * Handles nested forEach: each inner forEach overrides _blokIterationIndex
 * on its child ctx, so its inner steps carry their OWN iterationIndex
 * (not the outer's). The depth-aware memo correctly attributes those
 * indices to the inner scope.
 */
export function buildRailItems(sorted: NodeRun[]): RailItem[] {
	const items: RailItem[] = [];
	const memoByDepth: number[] = [];
	let prevDepth = -1;
	for (const node of sorted) {
		// Leaving a deeper scope — clear deeper memo entries so a fresh
		// iteration scope at the same shallower depth re-fires a header.
		if (node.depth < prevDepth) {
			memoByDepth.length = node.depth + 1;
		}
		const iter = node.iterationIndex;
		if (typeof iter === "number" && memoByDepth[node.depth] !== iter) {
			items.push({
				kind: "iteration-header",
				key: `iter-${node.depth}-${iter}-${node.id}`,
				iterIndex: iter,
				depth: node.depth,
			});
			memoByDepth[node.depth] = iter;
		}
		items.push({ kind: "node", node });
		prevDepth = node.depth;
	}
	return items;
}

function IterationHeader({ iterIndex, depth }: { iterIndex: number; depth: number }) {
	return (
		<div
			// Inline padding for nested-flow alignment — Tailwind can't
			// generate dynamic `pl-${expr}` at build time.
			style={{ paddingLeft: `${16 + depth * 12}px` }}
			className="w-full flex items-center gap-2 pl-4 pr-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500 select-none"
			aria-hidden="true"
		>
			<span className="font-mono text-[9px] text-zinc-700 w-3 shrink-0">↳</span>
			<span className="font-mono text-[10px] text-purple-300/80 shrink-0">iteration {iterIndex + 1}</span>
			<span className="flex-1 border-t border-zinc-800/60 ml-1" />
		</div>
	);
}

export function StepRail({ nodes, activeStepId, onSelect }: Props) {
	const sorted = useMemo(() => nodes.slice().sort((a, b) => a.stepIndex - b.stepIndex), [nodes]);
	const railItems = useMemo(() => buildRailItems(sorted), [sorted]);
	const completed = nodes.filter((n) => n.status === "completed").length;
	const failed = nodes.filter((n) => n.status === "failed").length;
	const running = nodes.filter((n) => n.status === "running").length;

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const useVirtual = railItems.length >= VIRTUALIZE_THRESHOLD;

	const virtualizer = useVirtualizer({
		count: useVirtual ? railItems.length : 0,
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
			{/* v0.5 middleware origin — when this step was produced by a
			    trigger.http.middleware dispatch, badge it with the
			    middleware's name so operators can tell `auth-check`'s
			    inner steps apart from `rate-limit`'s inner steps. */}
			{n.middleware && (
				<span
					className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-emerald-300/15 text-emerald-300 shrink-0"
					title={`middleware origin — emitted by trigger.http.middleware: "${n.middleware}"`}
				>
					mw:{n.middleware}
				</span>
			)}
			{/* Tier 2: sub-workflow indicator — `↳ sub` (sync) or `↳ async`
			    (fire-and-forget). Drill into the child via the "Sub-runs"
			    strip in the run header. PR 5 E3 — append depth count
			    when nested (depth >= 2) so operators see "↳ sub (3)" for
			    a third-level nested invocation. G2 follow-up — when the
			    step opted into `dispatch: "http-self"`, the sibling `http`
			    badge below picks it up; `in-process` (default + legacy
			    traces) renders unchanged. */}
			{n.nodeType === "subworkflow" && (
				<span
					className={cn(
						"font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded shrink-0",
						n.wait === false ? "bg-orange-300/15 text-orange-300" : "bg-zinc-700/40 text-zinc-300",
					)}
					title={
						(n.wait === false
							? `Async sub-workflow (fire-and-forget) — child runs independently; parent does NOT block${
									n.subworkflowDepth && n.subworkflowDepth >= 2 ? ` · nested at depth ${n.subworkflowDepth}` : ""
								}`
							: `Sub-workflow invocation (synchronous) — see Sub-runs in the header${
									n.subworkflowDepth && n.subworkflowDepth >= 2 ? ` · nested at depth ${n.subworkflowDepth}` : ""
								}`) +
						(n.dispatch === "http-self"
							? " · dispatched via HTTP self-call to BLOK_SELF_BASE_URL"
							: n.dispatch === "in-process"
								? " · dispatched in-process"
								: "")
					}
				>
					{n.wait === false ? "↳ async" : "↳ sub"}
					{n.subworkflowDepth && n.subworkflowDepth >= 2 ? ` (${n.subworkflowDepth})` : ""}
				</span>
			)}
			{/* G2 (v0.6) follow-up — sibling `http` badge when the
			    sub-workflow step ran via HTTP self-call. Distinct sky-blue
			    so it composes visually with the orange (async) / zinc
			    (sub) badge above instead of competing for the same slot.
			    No badge for the default in-process path — that's the
			    99% case and would just add visual noise. */}
			{n.nodeType === "subworkflow" && n.dispatch === "http-self" && (
				<span
					className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-sky-300/15 text-sky-300 shrink-0"
					title="HTTP self-call dispatch — child ran as a fresh HTTP request to BLOK_SELF_BASE_URL (potentially on a different process)."
				>
					http
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
			{/* v0.5 forEach — collection iteration. Output is the array of
			    per-iteration results; show its length so operators can see
			    the iteration count at a glance. */}
			{n.nodeType === "forEach" && (
				<span
					className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-purple-300/15 text-purple-300 shrink-0"
					title={
						Array.isArray(n.outputs)
							? `forEach — iterated ${n.outputs.length} item${n.outputs.length === 1 ? "" : "s"}`
							: "forEach — collection iteration; each child step rail row is one iteration's inner step"
					}
				>
					↳ forEach{Array.isArray(n.outputs) ? ` (${n.outputs.length})` : ""}
				</span>
			)}
			{/* v0.5 loop — while-loop with hard maxIterations cap. */}
			{n.nodeType === "loop" && (
				<span
					className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-blue-300/15 text-blue-300 shrink-0"
					title="loop — while-condition; runs until the expression goes falsy or maxIterations cap is hit"
				>
					↳ loop
				</span>
			)}
			{/* v0.5 switch — N-way branch; first matching `when` wins. */}
			{n.nodeType === "switch" && (
				<span
					className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-amber-300/15 text-amber-300 shrink-0"
					title="switch — N-way branch; the matched case's inner steps appear indented below"
				>
					↳ switch
				</span>
			)}
			{/* v0.5 tryCatch — JS-like try/catch/finally. */}
			{n.nodeType === "tryCatch" && (
				<span
					className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-rose-300/15 text-rose-300 shrink-0"
					title="tryCatch — try/catch/finally; failures in `try` jump to `catch`, finally always runs"
				>
					↳ try
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

			{/* Rows: non-virtualized for short runs, virtualized for long.
			    Headers (iteration N dividers) are interleaved with NodeRun
			    rows — both are 30px tall so virtualization math is uniform. */}
			{!useVirtual ? (
				<ul className="mt-1">
					{railItems.map((item) =>
						item.kind === "iteration-header" ? (
							<li key={item.key}>
								<IterationHeader iterIndex={item.iterIndex} depth={item.depth} />
							</li>
						) : (
							<li key={item.node.id}>{renderRow(item.node, item.node.id === activeStepId)}</li>
						),
					)}
				</ul>
			) : (
				<ul
					className="relative mt-1 list-none p-0 m-0"
					style={{ height: `${virtualizer.getTotalSize()}px` }}
					aria-label={`${railItems.length} steps`}
				>
					{virtualizer.getVirtualItems().map((vi) => {
						const item = railItems[vi.index];
						if (!item) return null;
						const key = item.kind === "iteration-header" ? item.key : item.node.id;
						return (
							<li
								key={key}
								className="absolute left-0 right-0"
								style={{ top: 0, transform: `translateY(${vi.start}px)`, height: `${vi.size}px` }}
							>
								{item.kind === "iteration-header" ? (
									<IterationHeader iterIndex={item.iterIndex} depth={item.depth} />
								) : (
									renderRow(item.node, item.node.id === activeStepId)
								)}
							</li>
						);
					})}
				</ul>
			)}
		</aside>
	);
}
