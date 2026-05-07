import { EmptyState } from "@/components/shared/EmptyState";
import { type DeploymentSummary, fetchDeployments } from "@/lib/api";
import { formatDuration, formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { useEnvScope } from "@/stores/envScope";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { GitBranch, Loader2 } from "lucide-react";

/**
 * Deployments — Direction A · Phase 5. "What versions of which
 * workflows are running where."
 *
 * Source-of-truth-from-runs: Blok doesn't keep a separate deployment
 * registry, so we group recent runs by `(workflowName, version, env)`
 * and report counts + success rate per group. Workflows declare their
 * `version` in metadata; rows show "unknown" for runs that didn't.
 *
 * Reads from /__blok/deployments which scans last-500 runs by default.
 */
export const Route = createFileRoute("/deployments")({
	component: DeploymentsPage,
});

function DeploymentsPage() {
	const env = useEnvScope((s) => s.current);
	const { data, isLoading, error } = useQuery({
		queryKey: ["deployments", env],
		queryFn: () => fetchDeployments({ env, limit: 500 }),
		refetchInterval: 10000,
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
					icon={<GitBranch className="w-10 h-10" />}
					title="Couldn't load deployments"
					description={
						<>
							The runner's <code className="font-mono">/__blok/deployments</code> endpoint didn't respond. Restart the
							trigger to pick up the new endpoint if you just rebuilt the runner.
						</>
					}
				/>
			</div>
		);
	}

	const deployments = data?.deployments ?? [];

	if (deployments.length === 0) {
		return (
			<div className="p-8">
				<EmptyState
					icon={<GitBranch className="w-10 h-10" />}
					title="No deployments seen"
					description={
						<>
							No runs in the last 500 carried a recognizable
							<code className="font-mono text-[12px] bg-raised border border-zinc-800 rounded px-1.5 py-0.5 mx-1 text-zinc-100">
								version
							</code>
							field, or the env scope
							<code className="font-mono text-[12px] bg-raised border border-zinc-800 rounded px-1.5 py-0.5 mx-1 text-zinc-100">
								{env}
							</code>
							hasn't seen any runs yet. Workflows declare their version in metadata via the trigger registry.
						</>
					}
				/>
			</div>
		);
	}

	return (
		<div className="p-6 max-w-6xl mx-auto space-y-5">
			<div>
				<h1 className="text-2xl font-medium font-display italic tracking-tight text-zinc-100">Deployments</h1>
				<p className="text-sm text-zinc-500 mt-1">
					Workflow versions seen in the last 500 runs. {deployments.length}{" "}
					{deployments.length === 1 ? "version" : "versions"} active in {env}.
				</p>
			</div>

			<div className="rounded-lg border border-zinc-800 bg-overlay overflow-hidden">
				<table className="w-full text-sm">
					<thead className="bg-canvas/60">
						<tr>
							<Th>Workflow</Th>
							<Th className="w-[110px]">Version</Th>
							<Th className="w-[110px]">Environment</Th>
							<Th className="w-[80px] text-right">Runs</Th>
							<Th className="w-[140px]">Success rate</Th>
							<Th className="w-[110px] text-right">Avg duration</Th>
							<Th className="w-[150px] text-right">Last run</Th>
						</tr>
					</thead>
					<tbody>
						{deployments.map((d) => (
							<DeploymentRow key={`${d.workflowName}-${d.version}-${d.environment}`} deployment={d} />
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function DeploymentRow({ deployment }: { deployment: DeploymentSummary }) {
	const successPct = deployment.successRate * 100;
	return (
		<tr className="border-t border-zinc-800 hover:bg-hover transition-colors">
			<td className="px-3 py-2.5">
				<Link
					to="/workflows/$name"
					params={{ name: deployment.workflowName }}
					className="text-zinc-100 hover:text-blok-green-500 hover:underline font-medium"
				>
					{deployment.workflowName}
				</Link>
			</td>
			<td className="px-3 py-2.5">
				<span
					className={cn(
						"inline-block font-mono text-[11px] px-1.5 py-0.5 rounded border",
						deployment.version === "unknown"
							? "bg-raised border-zinc-800 text-zinc-500"
							: "bg-blok-green-500/10 border-blok-green-500/30 text-blok-green-500",
					)}
				>
					{deployment.version}
				</span>
			</td>
			<td className="px-3 py-2.5 font-mono text-[11px] text-zinc-300">{deployment.environment}</td>
			<td className="px-3 py-2.5 font-mono text-[12px] text-zinc-100 text-right">{deployment.runs}</td>
			<td className="px-3 py-2.5">
				<div className="flex items-center gap-2">
					<div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
						<div
							className={cn(
								"h-full transition-all",
								successPct >= 99 ? "bg-blok-green-500" : successPct >= 90 ? "bg-status-running" : "bg-status-failed",
							)}
							style={{ width: `${successPct}%` }}
						/>
					</div>
					<span
						className={cn(
							"font-mono text-[11px] tabular-nums shrink-0",
							successPct >= 99 ? "text-blok-green-500" : successPct >= 90 ? "text-zinc-300" : "text-status-failed",
						)}
					>
						{successPct.toFixed(1)}%
					</span>
				</div>
			</td>
			<td className="px-3 py-2.5 font-mono text-[12px] text-zinc-300 text-right">
				{formatDuration(deployment.avgDurationMs)}
			</td>
			<td className="px-3 py-2.5 font-mono text-[11px] text-zinc-500 text-right">
				{formatRelativeTime(deployment.lastRunAt)}
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
