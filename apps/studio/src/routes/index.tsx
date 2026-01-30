import { createFileRoute } from "@tanstack/react-router";
import { Workflow, Loader2 } from "lucide-react";
import { useWorkflows } from "@/hooks/useWorkflows";
import { useGlobalStream } from "@/hooks/useGlobalStream";
import { StatsOverview } from "@/components/dashboard/StatsOverview";
import { WorkflowCard } from "@/components/dashboard/WorkflowCard";
import { LiveFeed } from "@/components/dashboard/LiveFeed";
import { EmptyState } from "@/components/shared/EmptyState";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const { data: workflows, isLoading, error } = useWorkflows();
  useGlobalStream();

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
          description={`Could not connect to Blok backend. Make sure your server is running and the trace API is enabled.`}
        />
      </div>
    );
  }

  if (!workflows || workflows.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Workflow className="w-12 h-12" />}
          title="No workflows yet"
          description="Run a workflow to see it appear here. Blok Studio automatically tracks all workflow executions."
        />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Dashboard</h1>
        <p className="text-sm text-zinc-500">
          Overview of all workflow executions
        </p>
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
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <LiveFeed />
          </div>
        </div>
      </div>
    </div>
  );
}
