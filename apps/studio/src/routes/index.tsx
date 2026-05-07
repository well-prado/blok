import { LiveFeed } from "@/components/dashboard/LiveFeed";
import { StatsOverview } from "@/components/dashboard/StatsOverview";
import { WorkflowCard } from "@/components/dashboard/WorkflowCard";
import { EmptyState } from "@/components/shared/EmptyState";
import { useWorkflows } from "@/hooks/useWorkflows";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Workflow } from "lucide-react";

export const Route = createFileRoute("/")({
	component: DashboardPage,
});

function DashboardPage() {
	const { data: workflows, isLoading, error } = useWorkflows();

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-6">
				<EmptyState
					icon={<Workflow className="w-12 h-12" />}
					title="Connection Error"
					description={
						"Could not connect to Blok backend. Make sure your server is running and the trace API is enabled."
					}
				/>
			</div>
		);
	}

	if (!workflows || workflows.length === 0) {
		return (
			<div className="p-8">
				<EmptyState
					icon={<Workflow className="w-10 h-10" />}
					title="No workflows yet · production"
					description={
						<>
							Trigger your first run to see it stream in real time here. Once a workflow runs in
							<code className="font-mono text-[12px] bg-raised border border-zinc-800 rounded px-1.5 py-0.5 mx-1 text-zinc-100">
								production
							</code>
							this page shows live success rate, p50 / p95 latency, and the last 50 events as they happen.
						</>
					}
					snippets={[
						{
							lang: "curl · http",
							code: `curl -X POST http://localhost:4000/cross-runtime-chain \\
  -H 'content-type: application/json' \\
  -d '{}'`,
						},
						{
							lang: "typescript · sdk",
							code: `// triggers/http/src/workflows/cross-runtime-chain.ts
await blok.run("cross-runtime-chain", {
  input: { },
});`,
						},
					]}
					docLink={{ href: "https://docs.blok.io/quickstart", label: "docs.blok.io/quickstart" }}
				/>
			</div>
		);
	}

	return (
		<div className="p-6 max-w-7xl mx-auto space-y-6">
			{/* Header — Newsreader italic on the page H1 per brand-spec
			    (hero numerals + page H1s only). */}
			<div>
				<h1 className="text-2xl font-medium font-display italic tracking-tight text-zinc-100">Overview</h1>
				<p className="text-sm text-zinc-500 mt-1">Live trace of every workflow execution.</p>
			</div>

			{/* Stats */}
			<StatsOverview workflows={workflows} />

			{/* Main content */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Workflow cards */}
				<div className="lg:col-span-2 space-y-3">
					<h2 className="text-sm font-medium text-zinc-400">Workflows</h2>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
						{workflows.map((wf) => (
							<WorkflowCard key={wf.name} workflow={wf} />
						))}
					</div>
				</div>

				{/* Live feed */}
				<div>
					<h2 className="text-sm font-medium text-zinc-400 mb-3">Live Feed</h2>
					<div className="rounded-lg border border-zinc-800 bg-overlay p-3">
						<LiveFeed />
					</div>
				</div>
			</div>
		</div>
	);
}
