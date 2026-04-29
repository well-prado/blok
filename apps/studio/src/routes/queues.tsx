import { EmptyState } from "@/components/shared/EmptyState";
import { type QueueSummary, fetchQueues } from "@/lib/api";
import { formatDuration, formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { useEnvScope } from "@/stores/envScope";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Activity, Clock, Globe, Loader2, Mail, Webhook } from "lucide-react";

/**
 * Queues — Direction A · Phase 5. "What's configured to receive work."
 *
 * Honest implementation given Blok's current architecture: HTTP
 * triggers are stateless so there's no real queue depth to show.
 * Future NATS JetStream integration will populate `depth` for
 * worker-triggered queues. Until then we list each registered
 * workflow's trigger spec + recent throughput so operators can answer
 * "is anything configured to fire on event X" without grepping the
 * codebase.
 *
 * Refresh: 5s (cheap aggregate; not as time-critical as a run trace).
 */
export const Route = createFileRoute("/queues")({
	component: QueuesPage,
});

function QueuesPage() {
	const env = useEnvScope((s) => s.current);
	const { data, isLoading, error } = useQuery({
		queryKey: ["queues", env],
		queryFn: () => fetchQueues({ env }),
		refetchInterval: 5000,
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-8">
				<EmptyState
					icon={<Activity className="w-10 h-10" />}
					title="Couldn't load queues"
					description={
						<>
							The runner's <code className="font-mono">/__blok/queues</code> endpoint didn't respond. Restart the
							trigger to pick up the new endpoint if you just rebuilt the runner.
						</>
					}
				/>
			</div>
		);
	}

	const queues = data?.queues ?? [];

	if (queues.length === 0) {
		return (
			<div className="p-8">
				<EmptyState
					icon={<Webhook className="w-10 h-10" />}
					title="No queues yet"
					description={
						<>
							No workflows are registered to receive work in
							<code className="font-mono text-[12px] bg-raised border border-zinc-800 rounded px-1.5 py-0.5 mx-1 text-zinc-100">
								{env}
							</code>
							. Once a workflow's trigger config is loaded by the trigger server, it'll appear here.
						</>
					}
					docLink={{ href: "https://docs.blok.io/triggers", label: "docs.blok.io/triggers" }}
				/>
			</div>
		);
	}

	return (
		<div className="p-6 max-w-6xl mx-auto space-y-5">
			<div>
				<h1 className="text-2xl font-medium font-display italic tracking-tight text-zinc-100">Queues</h1>
				<p className="text-sm text-zinc-500 mt-1">
					Triggers configured to receive work in {env}. {queues.length} {queues.length === 1 ? "queue" : "queues"}{" "}
					loaded.
				</p>
			</div>

			<div className="rounded-lg border border-zinc-800 bg-overlay overflow-hidden">
				<table className="w-full text-sm">
					<thead className="bg-canvas/60">
						<tr>
							<Th>Workflow</Th>
							<Th className="w-[140px]">Trigger</Th>
							<Th className="w-[80px]">Depth</Th>
							<Th className="w-[110px] text-right">Runs · 24h</Th>
							<Th className="w-[120px] text-right">Avg</Th>
							<Th className="w-[100px] text-right">Errors</Th>
							<Th className="w-[140px] text-right">Last run</Th>
						</tr>
					</thead>
					<tbody>
						{queues.map((q) => (
							<QueueRow key={q.id} queue={q} />
						))}
					</tbody>
				</table>
			</div>

			<p className="text-[11px] font-mono text-zinc-600">
				Stateless HTTP triggers don't have queue depth — depth is "—" until JetStream-backed worker queues land.
			</p>
		</div>
	);
}

function QueueRow({ queue }: { queue: QueueSummary }) {
	const Icon =
		queue.triggerType === "http"
			? Globe
			: queue.triggerType === "cron"
				? Clock
				: queue.triggerType === "email"
					? Mail
					: Webhook;
	return (
		<tr className="border-t border-zinc-800 hover:bg-hover transition-colors">
			<td className="px-3 py-2.5">
				<Link
					to="/workflows/$name"
					params={{ name: queue.name }}
					className="text-zinc-100 hover:text-blok-green-500 hover:underline font-medium"
				>
					{queue.name}
				</Link>
			</td>
			<td className="px-3 py-2.5">
				<span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-300">
					<Icon className="w-3 h-3 text-zinc-500" />
					{queue.triggerType}
				</span>
			</td>
			<td className="px-3 py-2.5 font-mono text-[12px] text-zinc-500">{queue.depth ?? "—"}</td>
			<td className="px-3 py-2.5 font-mono text-[12px] text-zinc-100 text-right">{queue.runs24h}</td>
			<td className="px-3 py-2.5 font-mono text-[12px] text-zinc-300 text-right">
				{formatDuration(queue.avgDurationMs)}
			</td>
			<td
				className={cn(
					"px-3 py-2.5 font-mono text-[12px] text-right",
					queue.errorRate > 0 ? "text-status-failed" : "text-zinc-600",
				)}
			>
				{queue.errorRate > 0 ? `${(queue.errorRate * 100).toFixed(1)}%` : "—"}
			</td>
			<td className="px-3 py-2.5 font-mono text-[11px] text-zinc-500 text-right">
				{queue.lastRunAt ? formatRelativeTime(queue.lastRunAt) : "—"}
			</td>
		</tr>
	);
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<th
			className={cn(
				"text-left text-[10px] uppercase tracking-[0.06em] text-zinc-500 font-semibold px-3 py-2",
				className,
			)}
		>
			{children}
		</th>
	);
}
