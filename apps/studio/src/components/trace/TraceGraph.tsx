import { STATUS_DOT_COLORS } from "@/lib/constants";
import { formatDuration } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { NodeRun } from "@/types";
import {
	Background,
	Controls,
	type Edge,
	Handle,
	MiniMap,
	type Node,
	type NodeProps,
	Position,
	ReactFlow,
} from "@xyflow/react";
import dagre from "dagre";
import { useCallback, useMemo } from "react";
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
			const prev = sortedNodes[i - 1];
			const curr = sortedNodes[i];
			if (!prev || !curr) continue;
			if (curr.parentNodeId) {
				g.setEdge(curr.parentNodeId, curr.id);
			} else if (prev.depth === curr.depth) {
				g.setEdge(prev.id, curr.id);
			} else if (curr.depth < prev.depth) {
				// Find the last node at the same depth
				for (let j = i - 1; j >= 0; j--) {
					const ancestor = sortedNodes[j];
					if (ancestor && ancestor.depth === curr.depth) {
						g.setEdge(ancestor.id, curr.id);
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
				style: { stroke: "var(--color-line-strong)", strokeWidth: 1.5 },
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
		<div className="h-[500px] rounded-md border border-line overflow-hidden">
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
				<Background color="var(--color-line)" gap={16} size={1} />
				<Controls
					showInteractive={false}
					className="bg-raised! border-line-strong! rounded-md! [&>button]:bg-overlay! [&>button]:border-line-strong! [&>button]:text-ink-dimmed! [&>button:hover]:bg-control!"
				/>
				<MiniMap
					nodeStrokeColor="var(--color-line-strong)"
					// Every status has a token, so the name is computed rather than a
					// three-case if-chain with a hex default — the default arm is what had
					// drifted (`#52525b`, and before that the pre-brand green `#22c55e`).
					// Safe to compute here because this is a CSS custom-property lookup at
					// runtime, NOT a Tailwind class name: `@theme static` emits all 14.
					// Fallback arm matters: a status the client union does not know yet
					// (backend drift) resolves to an undefined custom property, which
					// paints rgb(0,0,0) — an invisible node on the dark canvas, strictly
					// worse than the hex default this replaced.
					nodeColor={(node) =>
						`var(--color-status-${(node.data as { node: NodeRun }).node.status}, var(--color-line-strong))`
					}
					maskColor="color-mix(in srgb, var(--color-canvas) 60%, transparent)"
					className="bg-raised! border-line-strong! rounded-md!"
				/>
			</ReactFlow>
		</div>
	);
}

function TraceNodeComponent({ data }: NodeProps) {
	const { node, selected } = data as { node: NodeRun; selected: boolean };

	return (
		<>
			<Handle type="target" position={Position.Top} className="bg-line-bright! w-2! h-2! border-0!" />
			<div
				className={cn(
					"rounded-md border px-3 py-2 min-w-[160px] transition-all",
					// Selection is the brand accent, not `status-running` — a node can be
					// selected in any status and the two signals must not collide.
					selected
						? "border-accent bg-control ring-1 ring-accent/30"
						: "border-line-strong bg-overlay hover:border-line-bright",
				)}
			>
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"w-2 h-2 rounded-full shrink-0",
							STATUS_DOT_COLORS[node.status],
							node.status === "running" && "animate-pulse-dot",
						)}
					/>
					<span className="text-xs font-medium text-ink truncate">{node.nodeName}</span>
				</div>
				<div className="flex items-center gap-2 mt-1">
					{node.runtimeKind && <span className="text-[10px] text-ink-muted">{node.runtimeKind}</span>}
					<span className="text-[10px] font-mono text-ink-muted ml-auto">
						{node.status === "running" ? "..." : formatDuration(node.durationMs)}
					</span>
				</div>
			</div>
			<Handle type="source" position={Position.Bottom} className="bg-line-bright! w-2! h-2! border-0!" />
		</>
	);
}
