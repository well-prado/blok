import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock, CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { DurationBadge } from "@/components/shared/DurationBadge";
import { JsonViewer } from "@/components/shared/JsonViewer";
import { formatDuration, formatTimestamp } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { RunDetail, NodeRun } from "@/types";

interface DiffViewProps {
  runA: RunDetail;
  runB: RunDetail;
}

type DiffTab = "overview" | "nodes" | "outputs";

export function DiffView({ runA, runB }: DiffViewProps) {
  const [activeTab, setActiveTab] = useState<DiffTab>("overview");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const tabs: Array<{ key: DiffTab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "nodes", label: "Node Comparison" },
    { key: "outputs", label: "Output Diff" },
  ];

  // Match nodes by name for comparison
  const nodeComparison = useMemo(() => {
    const nodeMapA = new Map<string, NodeRun>();
    const nodeMapB = new Map<string, NodeRun>();
    for (const n of runA.nodes) nodeMapA.set(n.nodeName, n);
    for (const n of runB.nodes) nodeMapB.set(n.nodeName, n);

    const allNames = new Set([...nodeMapA.keys(), ...nodeMapB.keys()]);
    return Array.from(allNames).map((name) => ({
      name,
      nodeA: nodeMapA.get(name),
      nodeB: nodeMapB.get(name),
    }));
  }, [runA.nodes, runB.nodes]);

  return (
    <div className="p-4 space-y-4">
      {/* Run headers side by side */}
      <div className="grid grid-cols-2 gap-4">
        <RunSummaryCard run={runA} label="Run A" />
        <RunSummaryCard run={runB} label="Run B" />
      </div>

      {/* Quick comparison stats */}
      <div className="grid grid-cols-4 gap-3">
        <DiffStat
          label="Duration"
          valueA={formatDuration(runA.run.durationMs)}
          valueB={formatDuration(runB.run.durationMs)}
          comparison={compareDuration(runA.run.durationMs, runB.run.durationMs)}
        />
        <DiffStat
          label="Status"
          valueA={runA.run.status}
          valueB={runB.run.status}
          comparison={runA.run.status === runB.run.status ? "same" : "different"}
        />
        <DiffStat
          label="Nodes"
          valueA={`${runA.run.completedNodes}/${runA.run.nodeCount}`}
          valueB={`${runB.run.completedNodes}/${runB.run.nodeCount}`}
          comparison={runA.run.completedNodes === runB.run.completedNodes ? "same" : "different"}
        />
        <DiffStat
          label="Errors"
          valueA={runA.run.error ? "Yes" : "No"}
          valueB={runB.run.error ? "Yes" : "No"}
          comparison={
            (!runA.run.error && !runB.run.error) ? "same" :
            (runA.run.error && runB.run.error) ? "same" : "different"
          }
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-zinc-800">
        {tabs.map((tab) => (
          <button
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
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <OverviewTab runA={runA} runB={runB} nodeComparison={nodeComparison} />
      )}

      {activeTab === "nodes" && (
        <NodesTab
          nodeComparison={nodeComparison}
          selectedNode={selectedNode}
          onSelectNode={setSelectedNode}
          runA={runA}
          runB={runB}
        />
      )}

      {activeTab === "outputs" && (
        <OutputsTab nodeComparison={nodeComparison} />
      )}
    </div>
  );
}

// --- Sub-components ---

function RunSummaryCard({ run, label }: { run: RunDetail; label: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
          {label}
        </span>
        <StatusBadge status={run.run.status} />
      </div>
      <Link
        to="/runs/$runId"
        params={{ runId: run.run.id }}
        className="text-sm font-mono text-blue-400 hover:text-blue-300"
      >
        {run.run.id.slice(0, 16)}
      </Link>
      <div className="mt-2 space-y-1 text-xs text-zinc-500">
        <div>
          Trigger: <span className="text-zinc-400 font-mono">{run.run.triggerSummary}</span>
        </div>
        <div className="flex items-center gap-2">
          <Clock className="w-3 h-3" />
          <span className="text-zinc-400">{formatTimestamp(run.run.startedAt)}</span>
        </div>
        <div>
          Duration: <DurationBadge ms={run.run.durationMs} />
        </div>
        <div>
          Nodes: <span className="text-zinc-400">{run.run.completedNodes}/{run.run.nodeCount}</span>
        </div>
      </div>
    </div>
  );
}

function DiffStat({
  label,
  valueA,
  valueB,
  comparison,
}: {
  label: string;
  valueA: string;
  valueB: string;
  comparison: "same" | "better" | "worse" | "different";
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono text-zinc-300">{valueA}</span>
        <ArrowRight className="w-3 h-3 text-zinc-600" />
        <span
          className={cn(
            "text-sm font-mono",
            comparison === "same" && "text-zinc-300",
            comparison === "better" && "text-green-400",
            comparison === "worse" && "text-red-400",
            comparison === "different" && "text-amber-400",
          )}
        >
          {valueB}
        </span>
      </div>
    </div>
  );
}

function OverviewTab({
  runA,
  runB,
  nodeComparison,
}: {
  runA: RunDetail;
  runB: RunDetail;
  nodeComparison: Array<{ name: string; nodeA?: NodeRun; nodeB?: NodeRun }>;
}) {
  // Timeline comparison: show bars side by side
  const maxDuration = Math.max(
    ...[...runA.nodes, ...runB.nodes]
      .map((n) => n.durationMs || 0)
      .filter((d) => d > 0),
    1,
  );

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
        Timeline Comparison
      </h3>
      <div className="space-y-2">
        {nodeComparison.map(({ name, nodeA, nodeB }) => (
          <div key={name} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-xs font-medium text-zinc-300 mb-2">{name}</div>
            <div className="space-y-1.5">
              {/* Run A bar */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-600 w-6">A</span>
                {nodeA ? (
                  <>
                    <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded transition-all",
                          nodeA.status === "completed" && "bg-green-500/60",
                          nodeA.status === "failed" && "bg-red-500/60",
                          nodeA.status === "running" && "bg-blue-500/60",
                          nodeA.status === "skipped" && "bg-zinc-600",
                        )}
                        style={{ width: `${Math.max(((nodeA.durationMs || 0) / maxDuration) * 100, 2)}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-zinc-500 w-16 text-right">
                      {formatDuration(nodeA.durationMs)}
                    </span>
                  </>
                ) : (
                  <span className="text-[10px] text-zinc-600 italic">not present</span>
                )}
              </div>
              {/* Run B bar */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-600 w-6">B</span>
                {nodeB ? (
                  <>
                    <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded transition-all",
                          nodeB.status === "completed" && "bg-blue-500/60",
                          nodeB.status === "failed" && "bg-red-500/60",
                          nodeB.status === "running" && "bg-blue-500/60",
                          nodeB.status === "skipped" && "bg-zinc-600",
                        )}
                        style={{ width: `${Math.max(((nodeB.durationMs || 0) / maxDuration) * 100, 2)}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-zinc-500 w-16 text-right">
                      {formatDuration(nodeB.durationMs)}
                    </span>
                  </>
                ) : (
                  <span className="text-[10px] text-zinc-600 italic">not present</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NodesTab({
  nodeComparison,
  selectedNode,
  onSelectNode,
  runA,
  runB,
}: {
  nodeComparison: Array<{ name: string; nodeA?: NodeRun; nodeB?: NodeRun }>;
  selectedNode: string | null;
  onSelectNode: (name: string | null) => void;
  runA: RunDetail;
  runB: RunDetail;
}) {
  const selected = nodeComparison.find((n) => n.name === selectedNode);

  return (
    <div className="flex gap-4">
      {/* Node list */}
      <div className="w-64 space-y-1">
        {nodeComparison.map(({ name, nodeA, nodeB }) => {
          const statusMatch = nodeA?.status === nodeB?.status;
          const durationDiff =
            nodeA?.durationMs !== undefined && nodeB?.durationMs !== undefined
              ? nodeB.durationMs - nodeA.durationMs
              : null;

          return (
            <button
              key={name}
              type="button"
              onClick={() => onSelectNode(selectedNode === name ? null : name)}
              className={cn(
                "w-full text-left rounded-md px-3 py-2 text-sm transition-colors",
                selectedNode === name
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
              )}
            >
              <div className="flex items-center gap-2">
                {statusMatch ? (
                  <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
                ) : nodeA && nodeB ? (
                  <MinusCircle className="w-3 h-3 text-amber-500 flex-shrink-0" />
                ) : (
                  <XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
                )}
                <span className="truncate">{name}</span>
              </div>
              {durationDiff !== null && (
                <div className="text-[10px] mt-0.5 ml-5">
                  <span
                    className={cn(
                      "font-mono",
                      durationDiff > 0 ? "text-red-400" : durationDiff < 0 ? "text-green-400" : "text-zinc-600",
                    )}
                  >
                    {durationDiff > 0 ? "+" : ""}
                    {formatDuration(Math.abs(durationDiff))}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Detail */}
      <div className="flex-1">
        {selected ? (
          <div className="grid grid-cols-2 gap-4">
            <NodeCompareCard node={selected.nodeA} label="Run A" logs={runA.logs.filter((l) => l.nodeName === selected.name)} />
            <NodeCompareCard node={selected.nodeB} label="Run B" logs={runB.logs.filter((l) => l.nodeName === selected.name)} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-48 text-zinc-600 text-sm">
            Select a node to compare details
          </div>
        )}
      </div>
    </div>
  );
}

function NodeCompareCard({
  node,
  label,
  logs,
}: {
  node?: NodeRun;
  label: string;
  logs: RunDetail["logs"];
}) {
  if (!node) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-center text-zinc-600 text-sm">
        {label}: Not present in this run
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">{label}</span>
        <StatusBadge status={node.status} />
      </div>
      <div className="space-y-1 text-xs text-zinc-500">
        <div>Duration: <span className="text-zinc-300 font-mono">{formatDuration(node.durationMs)}</span></div>
        <div>Type: <span className="text-zinc-400">{node.nodeType}</span></div>
        {node.runtimeKind && <div>Runtime: <span className="text-zinc-400">{node.runtimeKind}</span></div>}
      </div>
      {node.error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded p-2 text-xs text-red-400">
          {node.error.message}
        </div>
      )}
      {node.inputs !== undefined && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">Input</div>
          <div className="max-h-32 overflow-y-auto">
            <JsonViewer data={node.inputs} />
          </div>
        </div>
      )}
      {node.outputs !== undefined && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">Output</div>
          <div className="max-h-32 overflow-y-auto">
            <JsonViewer data={node.outputs} />
          </div>
        </div>
      )}
      {logs.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">
            Logs ({logs.length})
          </div>
          <div className="max-h-24 overflow-y-auto space-y-0.5">
            {logs.map((log) => (
              <div key={log.id} className="text-[10px] font-mono text-zinc-500 truncate">
                <span className={cn(
                  log.level === "error" && "text-red-400",
                  log.level === "warn" && "text-amber-400",
                  log.level === "info" && "text-blue-400",
                )}>
                  [{log.level}]
                </span>{" "}
                {log.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OutputsTab({
  nodeComparison,
}: {
  nodeComparison: Array<{ name: string; nodeA?: NodeRun; nodeB?: NodeRun }>;
}) {
  const nodesWithOutputDiff = nodeComparison.filter(
    ({ nodeA, nodeB }) =>
      nodeA?.outputs !== undefined || nodeB?.outputs !== undefined,
  );

  if (nodesWithOutputDiff.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-zinc-600 text-sm">
        No node outputs to compare
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {nodesWithOutputDiff.map(({ name, nodeA, nodeB }) => {
        const outputsMatch =
          JSON.stringify(nodeA?.outputs) === JSON.stringify(nodeB?.outputs);

        return (
          <div key={name} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-medium text-zinc-300">{name}</span>
              {outputsMatch ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">
                  Identical
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
                  Different
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">
                  Run A Output
                </div>
                <div className="max-h-48 overflow-y-auto rounded bg-zinc-950 p-2">
                  {nodeA?.outputs !== undefined ? (
                    <JsonViewer data={nodeA.outputs} />
                  ) : (
                    <span className="text-xs text-zinc-600">No output</span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">
                  Run B Output
                </div>
                <div className="max-h-48 overflow-y-auto rounded bg-zinc-950 p-2">
                  {nodeB?.outputs !== undefined ? (
                    <JsonViewer data={nodeB.outputs} />
                  ) : (
                    <span className="text-xs text-zinc-600">No output</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function compareDuration(
  a: number | undefined,
  b: number | undefined,
): "same" | "better" | "worse" | "different" {
  if (a === undefined || b === undefined) return "different";
  if (a === b) return "same";
  // Faster is better — if B is faster, it's "better"
  const diff = Math.abs(b - a);
  const threshold = Math.max(a, b) * 0.1; // 10% threshold
  if (diff < threshold) return "same";
  return b < a ? "better" : "worse";
}
