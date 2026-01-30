import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
} from "@xyflow/react";
import dagre from "dagre";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/formatters";
import { STATUS_DOT_COLORS } from "@/lib/constants";
import type { NodeRun } from "@/types";
import "@xyflow/react/dist/style.css";

interface TraceGraphProps {
  run: { workflowName: string };
  nodes: NodeRun[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 50;

export function TraceGraph({ nodes, selectedNodeId, onSelectNode }: TraceGraphProps) {
  const { flowNodes, flowEdges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: "TB", nodesep: 30, ranksep: 50 });

    // Add nodes
    for (const node of nodes) {
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }

    // Add edges based on step order and parent relationships
    const sortedNodes = [...nodes].sort((a, b) => a.stepIndex - b.stepIndex);
    for (let i = 1; i < sortedNodes.length; i++) {
      const prev = sortedNodes[i - 1]!;
      const curr = sortedNodes[i]!;
      if (curr.parentNodeId) {
        g.setEdge(curr.parentNodeId, curr.id);
      } else if (prev.depth === curr.depth) {
        g.setEdge(prev.id, curr.id);
      } else if (curr.depth < prev.depth) {
        // Find the last node at the same depth
        for (let j = i - 1; j >= 0; j--) {
          if (sortedNodes[j]!.depth === curr.depth) {
            g.setEdge(sortedNodes[j]!.id, curr.id);
            break;
          }
        }
      }
    }

    dagre.layout(g);

    const fNodes: Node[] = nodes.map((node) => {
      const pos = g.node(node.id);
      return {
        id: node.id,
        type: "traceNode",
        position: { x: (pos?.x || 0) - NODE_WIDTH / 2, y: (pos?.y || 0) - NODE_HEIGHT / 2 },
        data: { node, selected: selectedNodeId === node.id },
      };
    });

    const fEdges: Edge[] = [];
    const edges = g.edges();
    for (const e of edges) {
      fEdges.push({
        id: `${e.v}-${e.w}`,
        source: e.v,
        target: e.w,
        animated: nodes.find((n) => n.id === e.w)?.status === "running",
        style: { stroke: "#3f3f46", strokeWidth: 1.5 },
      });
    }

    return { flowNodes: fNodes, flowEdges: fEdges };
  }, [nodes, selectedNodeId]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelectNode(node.id);
    },
    [onSelectNode],
  );

  const nodeTypes = useMemo(() => ({ traceNode: TraceNodeComponent }), []);

  return (
    <div className="h-[500px] rounded-lg border border-zinc-800 overflow-hidden">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={2}
      >
        <Background color="#27272a" gap={16} size={1} />
        <Controls
          showInteractive={false}
          className="!bg-zinc-900 !border-zinc-700 !rounded-md [&>button]:!bg-zinc-800 [&>button]:!border-zinc-700 [&>button]:!text-zinc-400 [&>button:hover]:!bg-zinc-700"
        />
        <MiniMap
          nodeStrokeColor="#3f3f46"
          nodeColor={(node) => {
            const status = (node.data as { node: NodeRun }).node.status;
            if (status === "completed") return "#22c55e";
            if (status === "running") return "#3b82f6";
            if (status === "failed") return "#ef4444";
            return "#52525b";
          }}
          maskColor="rgba(0,0,0,0.6)"
          className="!bg-zinc-900 !border-zinc-700 !rounded-md"
        />
      </ReactFlow>
    </div>
  );
}

function TraceNodeComponent({ data }: NodeProps) {
  const { node, selected } = data as { node: NodeRun; selected: boolean };

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-zinc-600 !w-2 !h-2 !border-0" />
      <div
        className={cn(
          "rounded-md border px-3 py-2 min-w-[160px] transition-all",
          selected
            ? "border-blue-500 bg-zinc-800 ring-1 ring-blue-500/30"
            : "border-zinc-700 bg-zinc-900 hover:border-zinc-600",
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "w-2 h-2 rounded-full flex-shrink-0",
              STATUS_DOT_COLORS[node.status],
              node.status === "running" && "animate-pulse-dot",
            )}
          />
          <span className="text-xs font-medium text-zinc-200 truncate">{node.nodeName}</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          {node.runtimeKind && (
            <span className="text-[10px] text-zinc-500">{node.runtimeKind}</span>
          )}
          <span className="text-[10px] font-mono text-zinc-500 ml-auto">
            {node.status === "running" ? "..." : formatDuration(node.durationMs)}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !w-2 !h-2 !border-0" />
    </>
  );
}
