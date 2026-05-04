import { ConcurrencyTile } from "@/components/runs/ConcurrencyTile";
import { RunFilters } from "@/components/runs/RunFilters";
import { RunsTable } from "@/components/runs/RunsTable";
import { EmptyState } from "@/components/shared/EmptyState";
import { useRuns } from "@/hooks/useRuns";
import { createFileRoute } from "@tanstack/react-router";
import { Activity, Loader2 } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/runs/")({
	component: AllRunsPage,
});

function AllRunsPage() {
	const [statusFilter, setStatusFilter] = useState("");
	const [page, setPage] = useState(1);
	const limit = 50;

	const { data, isLoading } = useRuns({
		status: statusFilter || undefined,
		limit,
		offset: (page - 1) * limit,
	});

	return (
		<div className="p-6 max-w-7xl mx-auto space-y-5">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-medium font-display italic tracking-tight text-zinc-100">All Runs</h1>
					<p className="text-sm text-zinc-500 mt-1">Every workflow execution across every trigger.</p>
				</div>
				{/* Tier 2 follow-up · live in-flight slots tile. Hidden when no
				    keys are active so it doesn't take space at idle. */}
				<ConcurrencyTile />
			</div>

			<RunFilters status={statusFilter} onStatusChange={setStatusFilter} />

			{isLoading ? (
				<div className="flex justify-center py-8">
					<Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
				</div>
			) : data && data.runs.length > 0 ? (
				<RunsTable
					runs={data.runs}
					total={data.total}
					page={page}
					limit={limit}
					onPageChange={setPage}
					showWorkflow
					enableBulk
				/>
			) : statusFilter ? (
				<EmptyState
					icon={<Activity className="w-10 h-10" />}
					title={`No ${statusFilter} runs match`}
					description={`Across the latest 50 runs, none have status "${statusFilter}". Either workflows have been quiet or the filter is too tight.`}
					action={
						<button
							type="button"
							onClick={() => setStatusFilter("")}
							className="px-3 py-1.5 rounded-md text-xs font-semibold bg-blok-green-500 text-[#00231b] hover:bg-blok-green-600 transition-colors"
						>
							Clear filter
						</button>
					}
				/>
			) : (
				<EmptyState
					icon={<Activity className="w-10 h-10" />}
					title="No runs yet"
					description={
						<>
							Trigger your first workflow to see it stream in real time. The chain test below exercises every SDK at
							once — useful for proving end-to-end connectivity before opening custom workflows.
						</>
					}
					snippets={[
						{
							lang: "curl · http",
							code: `curl -X POST http://localhost:4000/cross-runtime-chain \\
  -H 'content-type: application/json' \\
  -d '{}'`,
						},
					]}
					docLink={{ href: "https://docs.blok.io/quickstart", label: "docs.blok.io/quickstart" }}
				/>
			)}
		</div>
	);
}
