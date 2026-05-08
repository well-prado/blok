/**
 * Tier 2 follow-up · per-key in-flight concurrency tile.
 *
 * Polls `/__blok/concurrency/state` (5s interval) and renders a compact
 * tile listing active `(workflow, key)` buckets with their current
 * in-flight counts. Drop into the runs list page header (or any
 * dashboard) to give operators an at-a-glance view of which keys are
 * hot.
 *
 * Returns null (renders nothing) when no slots are in flight — keeps
 * the page uncluttered when nothing's happening.
 */

import { fetchConcurrencyHealth, fetchConcurrencyState } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";

export function ConcurrencyTile({ className }: { className?: string }) {
	const { data: state } = useQuery({
		queryKey: ["concurrency", "state"],
		queryFn: fetchConcurrencyState,
		refetchInterval: 5000,
		// Poll silently — failures are non-critical (the gate may not be
		// configured at all, in which case totalLeases stays 0).
		retry: false,
	});

	const { data: health } = useQuery({
		queryKey: ["concurrency", "health"],
		queryFn: fetchConcurrencyHealth,
		refetchInterval: 30_000,
		retry: false,
	});

	if (!state || state.totalLeases === 0) return null;

	// Sort buckets by inFlight DESC so the busiest key is at the top.
	const sortedBuckets = [...state.buckets].sort((a, b) => b.inFlight - a.inFlight);

	return (
		<div
			className={cn(
				"rounded-md border border-zinc-800 bg-canvas px-3 py-2 text-xs",
				"flex flex-col gap-2 min-w-[260px]",
				className,
			)}
		>
			<div className="flex items-center justify-between">
				<span className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold">In-flight slots</span>
				<span className="text-[10px] text-zinc-500">
					{state.totalLeases} across {state.totalBuckets} keys
					{health && health.backend !== "in-process" ? (
						<span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-400/10 text-emerald-400">{health.backend}</span>
					) : null}
				</span>
			</div>
			<ul className="flex flex-col gap-1 max-h-40 overflow-y-auto">
				{sortedBuckets.slice(0, 10).map((b) => (
					<li
						key={`${b.workflowName}__${b.concurrencyKey}`}
						className="flex items-center justify-between gap-2 text-zinc-300"
					>
						<span className="truncate font-mono text-[11px]" title={`${b.workflowName} / ${b.concurrencyKey}`}>
							<span className="text-zinc-500">{b.workflowName}</span>
							<span className="text-zinc-600"> / </span>
							<span>{b.concurrencyKey}</span>
						</span>
						<span className="font-semibold text-amber-300 shrink-0">{b.inFlight}</span>
					</li>
				))}
			</ul>
			{sortedBuckets.length > 10 && (
				<span className="text-[10px] text-zinc-500">…and {sortedBuckets.length - 10} more</span>
			)}
		</div>
	);
}
