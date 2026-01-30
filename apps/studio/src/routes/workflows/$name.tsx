import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, Loader2, Workflow } from "lucide-react";
import { useWorkflowDetail } from "@/hooks/useWorkflows";
import { useWorkflowRuns } from "@/hooks/useRuns";
import { RunsTable } from "@/components/runs/RunsTable";
import { RunFilters } from "@/components/runs/RunFilters";
import { EmptyState } from "@/components/shared/EmptyState";
import { formatDuration, formatPercent } from "@/lib/formatters";
import { JsonViewer } from "@/components/shared/JsonViewer";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/workflows/$name")({
  component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
  const { name } = Route.useParams();
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState<"runs" | "definition" | "metrics">("runs");
  const limit = 25;

  const { data: detail, isLoading: detailLoading } = useWorkflowDetail(name);
  const { data: runsData, isLoading: runsLoading } = useWorkflowRuns(name, {
    status: statusFilter || undefined,
    limit,
    offset: (page - 1) * limit,
  });

  if (detailLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Workflow className="w-12 h-12" />}
          title="Workflow not found"
          description={`No workflow named "${name}" was found.`}
        />
      </div>
    );
  }

  const tabs = [
    { key: "runs" as const, label: "Runs" },
    { key: "definition" as const, label: "Definition" },
    { key: "metrics" as const, label: "Metrics" },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/" className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">{name}</h1>
          <p className="text-sm text-zinc-500">
            {detail.triggerTypes.join(", ")} &middot; {detail.totalRuns} runs &middot; avg {formatDuration(detail.avgDurationMs)} &middot; {formatPercent(detail.errorRate)} errors
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-zinc-800">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
              activeTab === tab.key
                ? "border-blue-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "runs" && (
        <div className="space-y-3">
          <RunFilters status={statusFilter} onStatusChange={setStatusFilter} />
          {runsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
            </div>
          ) : runsData && runsData.runs.length > 0 ? (
            <RunsTable
              runs={runsData.runs}
              total={runsData.total}
              page={page}
              limit={limit}
              onPageChange={setPage}
            />
          ) : (
            <EmptyState
              icon={<Workflow className="w-10 h-10" />}
              title="No runs"
              description={statusFilter ? `No ${statusFilter} runs found.` : "This workflow hasn't been executed yet."}
            />
          )}
        </div>
      )}

      {activeTab === "definition" && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <JsonViewer data={detail.definition || { nodeNames: detail.nodeNames, runtimes: detail.runtimes }} />
        </div>
      )}

      {activeTab === "metrics" && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricCard label="Total Runs" value={String(detail.totalRuns)} />
          <MetricCard label="Recent (24h)" value={String(detail.recentRuns)} />
          <MetricCard label="Avg Duration" value={formatDuration(detail.avgDurationMs)} />
          <MetricCard label="P95 Duration" value={formatDuration(detail.p95DurationMs)} />
          <MetricCard label="Error Rate" value={formatPercent(detail.errorRate)} />
          <MetricCard label="Runtimes" value={detail.runtimes.join(", ") || "—"} />
          <MetricCard label="Nodes" value={String(detail.nodeNames.length)} />
          <MetricCard label="Triggers" value={detail.triggerTypes.join(", ")} />
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-lg font-semibold text-zinc-100 font-mono">{value}</div>
    </div>
  );
}
