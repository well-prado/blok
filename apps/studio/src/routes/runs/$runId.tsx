import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { ArrowLeft, Loader2, Activity, RotateCcw, Send } from "lucide-react";
import { useRunDetail, useTraceStream } from "@/hooks/useRunDetail";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { DurationBadge } from "@/components/shared/DurationBadge";
import { EmptyState } from "@/components/shared/EmptyState";
import { TraceTimeline } from "@/components/trace/TraceTimeline";
import { TraceGraph } from "@/components/trace/TraceGraph";
import { NodeDetail } from "@/components/trace/NodeDetail";
import { LogViewer } from "@/components/trace/LogViewer";
import { EventLog } from "@/components/trace/EventLog";
import { RequestBuilder } from "@/components/trace/RequestBuilder";
import { replayRun, exportRunJson, exportRunCsv } from "@/lib/api";
import { formatTimestamp } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { TagEditor } from "@/components/shared/TagEditor";
import { ExportMenu } from "@/components/shared/ExportMenu";
import { ExplainError } from "@/components/trace/ExplainError";

export const Route = createFileRoute("/runs/$runId")({
  component: RunTracePage,
});

function RunTracePage() {
  const { runId } = Route.useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useRunDetail(runId);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "timeline" | "graph" | "logs" | "events" | "request"
  >("timeline");
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  // Subscribe to SSE for live updates
  useTraceStream(runId);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      // Don't intercept when command palette might be open (Cmd+K)
      if (e.metaKey || e.ctrlKey) return;
      switch (e.key) {
        case "1":
          setActiveTab("timeline");
          break;
        case "2":
          setActiveTab("graph");
          break;
        case "3":
          setActiveTab("logs");
          break;
        case "4":
          setActiveTab("events");
          break;
        case "5":
          setActiveTab("request");
          break;
        case "Escape":
          setSelectedNodeId(null);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const selectedNode = useMemo(() => {
    if (!data || !selectedNodeId) return null;
    return data.nodes.find((n) => n.id === selectedNodeId) || null;
  }, [data, selectedNodeId]);

  const nodeNames = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.nodes.map((n) => n.nodeName))];
  }, [data]);

  // Parse trigger summary for request builder defaults
  const triggerParts = useMemo(() => {
    if (!data) return { method: "GET", path: "/" };
    const parts = data.run.triggerSummary.split(" ");
    return { method: parts[0] || "GET", path: parts[1] || "/" };
  }, [data]);

  const handleReplay = async () => {
    if (!data || replaying) return;
    setReplaying(true);
    setReplayError(null);

    try {
      const result = await replayRun(runId);
      navigate({ to: "/runs/$runId", params: { runId: result.newRunId } });
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : "Replay failed");
    } finally {
      setReplaying(false);
    }
  };

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
          icon={<Activity className="w-12 h-12" />}
          title="Run not found"
          description={`No run with ID "${runId}" was found.`}
        />
      </div>
    );
  }

  const { run, nodes, logs } = data;
  const isHttpTrigger = run.triggerType === "http";
  const isFinished = run.status === "completed" || run.status === "failed" || run.status === "cancelled";

  const tabs = [
    { key: "timeline" as const, label: "Timeline", shortcut: "1" },
    { key: "graph" as const, label: "Graph", shortcut: "2" },
    { key: "logs" as const, label: "Logs", shortcut: "3" },
    { key: "events" as const, label: "Events", shortcut: "4" },
    ...(isHttpTrigger
      ? [{ key: "request" as const, label: "Request", shortcut: "5" }]
      : []),
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-950/50 px-4 py-3">
        <div className="flex items-center gap-3 mb-1">
          <Link
            to="/workflows/$name"
            params={{ name: run.workflowName }}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <span className="text-sm text-zinc-500">{run.workflowName}</span>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-mono text-zinc-400">{run.id.slice(0, 12)}</span>
          <StatusBadge status={run.status} />
          <DurationBadge
            ms={run.status === "running" ? run.startedAt : run.durationMs}
            running={run.status === "running"}
          />

          {/* Spacer to push action buttons to the right */}
          <div className="ml-auto flex items-center gap-2">
            {/* Replay button — only for finished HTTP runs */}
            {isFinished && isHttpTrigger && (
              <button
                type="button"
                onClick={handleReplay}
                disabled={replaying}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  replaying
                    ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100",
                )}
                title="Replay this run with the same request"
              >
                {replaying ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RotateCcw className="w-3 h-3" />
                )}
                Replay
              </button>
            )}

            {/* Request Builder button — for HTTP triggers */}
            {isHttpTrigger && (
              <button
                type="button"
                onClick={() => setActiveTab("request")}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  activeTab === "request"
                    ? "bg-blue-600/20 text-blue-400"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100",
                )}
                title="Open request builder"
              >
                <Send className="w-3 h-3" />
                Request
              </button>
            )}

            {/* Explain Error — only for failed runs */}
            {run.status === "failed" && run.error && (
              <ExplainError runId={runId} />
            )}

            {/* Export menu */}
            <ExportMenu
              onExportJson={() => exportRunJson(runId)}
              onExportCsv={() => exportRunCsv(runId)}
            />
          </div>
        </div>

        {/* AI explanation panel — rendered below header actions when active */}

        <div className="flex items-center gap-4 text-xs text-zinc-500 ml-9">
          <span>
            Trigger:{" "}
            <span className="text-zinc-400 font-mono">{run.triggerSummary}</span>
          </span>
          <span>
            Started: <span className="text-zinc-400">{formatTimestamp(run.startedAt)}</span>
          </span>
          <span>
            Nodes:{" "}
            <span className="text-zinc-400">
              {run.completedNodes}/{run.nodeCount}
            </span>
          </span>
          {replayError && <span className="text-red-400">{replayError}</span>}
        </div>
        {/* Tags */}
        <div className="ml-9 mt-1">
          <TagEditor runId={run.id} tags={run.tags || []} />
        </div>
      </div>

      {/* Tabs */}
      <div className="shrink-0 flex gap-0 border-b border-zinc-800 px-4">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
              activeTab === tab.key
                ? "border-blue-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300",
            )}
          >
            {tab.label}
            <span className="ml-1.5 text-[10px] text-zinc-600">{tab.shortcut}</span>
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden flex">
        {/* Main panel */}
        <div
          className={cn(
            "overflow-y-auto transition-all",
            selectedNode && activeTab !== "request" ? "flex-1" : "w-full",
          )}
        >
          {activeTab === "timeline" && (
            <div className="p-4">
              <TraceTimeline
                run={run}
                nodes={nodes}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            </div>
          )}

          {activeTab === "graph" && (
            <div className="p-4">
              <TraceGraph
                run={run}
                nodes={nodes}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            </div>
          )}

          {activeTab === "logs" && (
            <div className="h-full">
              <LogViewer logs={logs} nodeNames={nodeNames} />
            </div>
          )}

          {activeTab === "events" && (
            <div className="p-4">
              <EventLog runId={runId} />
            </div>
          )}

          {activeTab === "request" && (
            <RequestBuilder
              defaultMethod={triggerParts.method}
              defaultPath={triggerParts.path}
              onClose={() => setActiveTab("timeline")}
            />
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && activeTab !== "request" && (
          <div className="w-80 border-l border-zinc-800 bg-zinc-950/50 overflow-hidden shrink-0">
            <NodeDetail
              node={selectedNode}
              logs={logs}
              onClose={() => setSelectedNodeId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
