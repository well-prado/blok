import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BarChart3, Loader2 } from "lucide-react";
import { useMetrics } from "@/hooks/useMetrics";
import { useWorkflows } from "@/hooks/useWorkflows";
import { EmptyState } from "@/components/shared/EmptyState";
import { ExecutionTimeline } from "@/components/metrics/ExecutionTimeline";
import { DurationDistribution } from "@/components/metrics/DurationDistribution";
import { WorkflowBreakdown } from "@/components/metrics/WorkflowBreakdown";
import { NodePerformance } from "@/components/metrics/NodePerformance";
import { formatDuration, formatPercent } from "@/lib/formatters";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/metrics")({
  component: MetricsPage,
});

function MetricsPage() {
  const { data: workflows } = useWorkflows();
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | undefined>(
    undefined,
  );
  const { data: metrics, isLoading } = useMetrics(selectedWorkflow);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
      </div>
    );
  }

  if (!metrics || metrics.totalRuns === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<BarChart3 className="w-12 h-12" />}
          title="No metrics yet"
          description="Execute some workflows to see metrics and analytics here."
        />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Metrics</h1>
          <p className="text-sm text-zinc-500">
            Execution analytics and performance insights
          </p>
        </div>
        {/* Workflow filter */}
        {workflows && workflows.length > 1 && (
          <select
            value={selectedWorkflow || ""}
            onChange={(e) =>
              setSelectedWorkflow(e.target.value || undefined)
            }
            className="text-sm bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-zinc-300 outline-none focus:border-blue-500"
          >
            <option value="">All Workflows</option>
            {workflows.map((wf) => (
              <option key={wf.name} value={wf.name}>
                {wf.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        <MetricCard label="Total Runs" value={String(metrics.totalRuns)} />
        <MetricCard
          label="Completed"
          value={String(metrics.completedRuns)}
          color="text-green-400"
        />
        <MetricCard
          label="Failed"
          value={String(metrics.failedRuns)}
          color={metrics.failedRuns > 0 ? "text-red-400" : undefined}
        />
        <MetricCard
          label="Error Rate"
          value={formatPercent(
            metrics.totalRuns > 0
              ? metrics.failedRuns / metrics.totalRuns
              : 0,
          )}
          color={metrics.failedRuns > 0 ? "text-red-400" : undefined}
        />
        <MetricCard
          label="Avg Duration"
          value={formatDuration(metrics.avgDurationMs)}
        />
        <MetricCard
          label="P95 Duration"
          value={formatDuration(metrics.p95DurationMs)}
        />
        <MetricCard
          label="P99 Duration"
          value={formatDuration(metrics.p99DurationMs)}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Execution Timeline */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">
            Execution Timeline (24h)
          </h3>
          <ExecutionTimeline data={metrics.executionTimeline} />
        </div>

        {/* Duration Distribution */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">
            Duration Distribution
          </h3>
          <DurationDistribution data={metrics.durationDistribution} />
        </div>
      </div>

      {/* Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Workflow Breakdown */}
        {!selectedWorkflow && metrics.workflowBreakdown.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="text-sm font-medium text-zinc-300 mb-4">
              Workflow Breakdown
            </h3>
            <WorkflowBreakdown data={metrics.workflowBreakdown} />
          </div>
        )}

        {/* Node Performance */}
        {metrics.nodePerformance.length > 0 && (
          <div className={cn(
            "rounded-lg border border-zinc-800 bg-zinc-900/50 p-4",
            selectedWorkflow ? "lg:col-span-2" : "",
          )}>
            <h3 className="text-sm font-medium text-zinc-300 mb-4">
              Node Performance
            </h3>
            <NodePerformance data={metrics.nodePerformance} />
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">
        {label}
      </div>
      <div className={cn("text-lg font-semibold font-mono", color || "text-zinc-100")}>
        {value}
      </div>
    </div>
  );
}
