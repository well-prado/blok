import { EmptyState } from "@/components/shared/EmptyState";
import { DiffView } from "@/components/trace/DiffView";
import { useRunDiff } from "@/hooks/useMetrics";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, GitCompareArrows, Loader2 } from "lucide-react";

interface DiffSearch {
	a?: string;
	b?: string;
}

export const Route = createFileRoute("/runs/diff")({
	validateSearch: (search: Record<string, unknown>): DiffSearch => ({
		a: search.a as string | undefined,
		b: search.b as string | undefined,
	}),
	component: DiffPage,
});

function DiffPage() {
	const { a, b } = Route.useSearch();
	const { data, isLoading, error } = useRunDiff(a || "", b || "");

	if (!a || !b) {
		return (
			<div className="p-6">
				<EmptyState
					icon={<GitCompareArrows className="w-12 h-12" />}
					title="Select two runs to compare"
					description="Use the compare button on the workflow runs table to select two runs for side-by-side comparison."
				/>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
			</div>
		);
	}

	if (error || !data) {
		return (
			<div className="p-6">
				<EmptyState
					icon={<GitCompareArrows className="w-12 h-12" />}
					title="Comparison failed"
					description={error instanceof Error ? error.message : "Could not load the runs for comparison."}
				/>
			</div>
		);
	}

	return (
		<div className="h-full flex flex-col">
			{/* Header */}
			<div className="shrink-0 border-b border-zinc-800 bg-canvas/60 px-4 py-3">
				<div className="flex items-center gap-3">
					<Link
						to="/runs"
						className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
					>
						<ArrowLeft className="w-4 h-4" />
					</Link>
					<GitCompareArrows className="w-4 h-4 text-zinc-500" />
					<h1 className="text-sm font-medium text-zinc-200">Run Comparison</h1>
					<span className="text-xs text-zinc-600">{data.runA.run.workflowName}</span>
				</div>
			</div>

			{/* Diff content */}
			<div className="flex-1 overflow-y-auto">
				<DiffView runA={data.runA} runB={data.runB} />
			</div>
		</div>
	);
}
