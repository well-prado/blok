import { EmptyState } from "@/components/shared/EmptyState";
import { useCancelRun, useScheduledDispatches } from "@/hooks/useScheduledDispatches";
import { cn } from "@/lib/utils";
import { Link, createFileRoute } from "@tanstack/react-router";
import { CalendarClock, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/scheduled")({
	component: ScheduledRunsPage,
});

type ScheduledStatus = "delayed" | "queued" | "debounced";

const STATUS_LABELS: Record<ScheduledStatus, string> = {
	delayed: "Delayed",
	queued: "Queued",
	debounced: "Debounced",
};

/**
 * Tailwind class fragments per status. Match the colour vocabulary
 * used by `RunsTable`'s status badge so the same status reads the
 * same across views (delayed = amber, queued = indigo, debounced
 * = violet).
 */
const STATUS_STYLES: Record<ScheduledStatus, string> = {
	delayed: "bg-amber-500/10 text-amber-300 ring-amber-500/20",
	queued: "bg-indigo-500/10 text-indigo-300 ring-indigo-500/20",
	debounced: "bg-violet-500/10 text-violet-300 ring-violet-500/20",
};

function ScheduledRunsPage() {
	const [statusFilter, setStatusFilter] = useState<ScheduledStatus | "">("");
	const { data, isLoading } = useScheduledDispatches({
		status: statusFilter ? [statusFilter] : undefined,
		limit: 200,
	});
	const cancel = useCancelRun();

	// Re-render the page every second to drive accurate "fires in 27s"
	// countdowns. The underlying query polls every 3s; this hook just
	// re-runs the time arithmetic against the cached server snapshot.
	const [, setTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, []);

	const rows = data?.rows ?? [];
	const serverNowSnapshot = data?.now ?? Date.now();
	const localNowSnapshot = Date.now();

	return (
		<div className="p-6 max-w-7xl mx-auto space-y-5">
			<div>
				<h1 className="text-2xl font-medium font-display italic tracking-tight text-zinc-100">Scheduled</h1>
				<p className="text-sm text-zinc-500 mt-1">
					Pending dispatches waiting on `delay`, `debounce`, or `concurrencyKey` queue mode. Already-fired and expired
					runs live in{" "}
					<Link to="/runs" className="text-zinc-300 hover:text-zinc-100 underline">
						All Runs
					</Link>
					.
				</p>
			</div>

			<StatusFilter value={statusFilter} onChange={setStatusFilter} />

			{isLoading ? (
				<div className="flex justify-center py-8">
					<Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
				</div>
			) : rows.length > 0 ? (
				<ScheduledTable
					rows={rows}
					serverNow={serverNowSnapshot}
					localNow={localNowSnapshot}
					onCancel={(runId) => cancel.mutate(runId)}
					cancellingRunId={cancel.isPending ? (cancel.variables ?? null) : null}
				/>
			) : statusFilter ? (
				<EmptyState
					icon={<CalendarClock className="w-10 h-10" />}
					title={`No ${STATUS_LABELS[statusFilter].toLowerCase()} dispatches`}
					description={`Nothing is currently in the "${statusFilter}" state.`}
					action={
						<button
							type="button"
							onClick={() => setStatusFilter("")}
							className="px-3 py-1.5 rounded-md text-xs font-semibold bg-blok-green-500 text-[#00231b] hover:bg-blok-green-600 transition-colors"
						>
							Show all
						</button>
					}
				/>
			) : (
				<EmptyState
					icon={<CalendarClock className="w-10 h-10" />}
					title="No scheduled dispatches"
					description={
						<>
							Configure a trigger with <code className="text-zinc-300">delay</code>,{" "}
							<code className="text-zinc-300">debounce</code>, or{" "}
							<code className="text-zinc-300">onLimit: "queue"</code> to see pending dispatches land here before they
							fire.
						</>
					}
					docLink={{ href: "https://docs.blok.io/d/reliability/delay-ttl-debounce", label: "Scheduling docs" }}
				/>
			)}
		</div>
	);
}

interface StatusFilterProps {
	value: ScheduledStatus | "";
	onChange: (next: ScheduledStatus | "") => void;
}

function StatusFilter({ value, onChange }: StatusFilterProps) {
	const options: Array<{ label: string; value: ScheduledStatus | "" }> = [
		{ label: "All", value: "" },
		{ label: "Delayed", value: "delayed" },
		{ label: "Queued", value: "queued" },
		{ label: "Debounced", value: "debounced" },
	];
	return (
		<div className="flex gap-1.5">
			{options.map((opt) => (
				<button
					key={opt.value || "all"}
					type="button"
					onClick={() => onChange(opt.value)}
					className={cn(
						"px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
						value === opt.value
							? "bg-blok-green-500/10 text-blok-green-300 ring-1 ring-inset ring-blok-green-500/30"
							: "bg-hover text-zinc-400 hover:text-zinc-200 hover:bg-raised",
					)}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}

interface ScheduledTableProps {
	rows: Array<{
		runId: string;
		workflowName: string;
		dispatchStatus: ScheduledStatus;
		scheduledAt: number;
		expiresAt?: number;
		createdAt: number;
	}>;
	/**
	 * Server-side `Date.now()` snapshot from the API response. We
	 * compute countdowns against this anchor (plus the local-clock
	 * delta since the response arrived) so they stay accurate even if
	 * the client clock is skewed.
	 */
	serverNow: number;
	/** `Date.now()` at the moment the response was first received. */
	localNow: number;
	onCancel: (runId: string) => void;
	cancellingRunId: string | null;
}

function ScheduledTable({ rows, serverNow, localNow, onCancel, cancellingRunId }: ScheduledTableProps) {
	// Effective "now" used for countdowns: server snapshot + the local
	// time elapsed since the response arrived. This keeps the column
	// accurate across long polling intervals AND across client-clock
	// skew (operator's laptop drifted vs the server).
	const effectiveNow = serverNow + (Date.now() - localNow);

	return (
		<div className="overflow-x-auto rounded-lg border border-zinc-800">
			<table className="w-full text-sm">
				<thead className="bg-raised text-zinc-400 text-xs uppercase tracking-wide">
					<tr>
						<th className="text-left px-4 py-2.5 font-medium">Status</th>
						<th className="text-left px-4 py-2.5 font-medium">Workflow</th>
						<th className="text-left px-4 py-2.5 font-medium">Fires in</th>
						<th className="text-left px-4 py-2.5 font-medium">Expires</th>
						<th className="text-left px-4 py-2.5 font-medium">Run ID</th>
						<th className="text-right px-4 py-2.5 font-medium">Action</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const fireInMs = row.scheduledAt - effectiveNow;
						const expireInMs = row.expiresAt ? row.expiresAt - effectiveNow : null;
						return (
							<tr key={row.runId} className="border-t border-zinc-800 hover:bg-hover">
								<td className="px-4 py-2.5">
									<span
										className={cn(
											"inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ring-inset",
											STATUS_STYLES[row.dispatchStatus],
										)}
									>
										{STATUS_LABELS[row.dispatchStatus]}
									</span>
								</td>
								<td className="px-4 py-2.5 text-zinc-200">
									<Link
										to="/workflows/$name"
										params={{ name: row.workflowName }}
										className="hover:text-zinc-100 hover:underline"
									>
										{row.workflowName}
									</Link>
								</td>
								<td className="px-4 py-2.5 text-zinc-300 tabular-nums">{formatCountdown(fireInMs)}</td>
								<td className="px-4 py-2.5 text-zinc-500 tabular-nums">
									{expireInMs === null ? "—" : formatCountdown(expireInMs)}
								</td>
								<td className="px-4 py-2.5 text-zinc-500 font-mono text-xs">
									<Link to="/runs/$runId" params={{ runId: row.runId }} className="hover:text-zinc-300">
										{row.runId.slice(0, 12)}…
									</Link>
								</td>
								<td className="px-4 py-2.5 text-right">
									<button
										type="button"
										onClick={() => onCancel(row.runId)}
										disabled={cancellingRunId === row.runId}
										className={cn(
											"inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors",
											cancellingRunId === row.runId
												? "bg-hover text-zinc-500 cursor-not-allowed"
												: "bg-hover text-zinc-300 hover:bg-raised hover:text-zinc-100",
										)}
									>
										{cancellingRunId === row.runId ? (
											<Loader2 className="w-3 h-3 animate-spin" />
										) : (
											<X className="w-3 h-3" />
										)}
										Cancel
									</button>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/**
 * Format a "fires in / expires in" duration. Negative values mean the
 * deadline has passed but the row hasn't been pruned yet (e.g. timer
 * just fired and the periodic poll hasn't refreshed the list — should
 * resolve within one cycle).
 */
function formatCountdown(ms: number): string {
	if (ms <= 0) {
		const past = Math.abs(ms);
		if (past < 1000) return "now";
		if (past < 60000) return `${Math.floor(past / 1000)}s ago`;
		return `${Math.floor(past / 60000)}m ago`;
	}
	if (ms < 1000) return "<1s";
	if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3600000) {
		const m = Math.floor(ms / 60000);
		const s = Math.floor((ms % 60000) / 1000);
		return `${m}m ${s}s`;
	}
	const h = Math.floor(ms / 3600000);
	const m = Math.floor((ms % 3600000) / 60000);
	return `${h}h ${m}m`;
}
