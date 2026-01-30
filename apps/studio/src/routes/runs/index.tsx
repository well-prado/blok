import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { useRuns } from "@/hooks/useRuns";
import { RunsTable } from "@/components/runs/RunsTable";
import { RunFilters } from "@/components/runs/RunFilters";
import { EmptyState } from "@/components/shared/EmptyState";

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
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">All Runs</h1>
        <p className="text-sm text-zinc-500">
          All workflow executions across all workflows
        </p>
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
        />
      ) : (
        <EmptyState
          icon={<Activity className="w-10 h-10" />}
          title="No runs"
          description={statusFilter ? `No ${statusFilter} runs found.` : "No workflow runs recorded yet. Execute a workflow to see it here."}
        />
      )}
    </div>
  );
}
