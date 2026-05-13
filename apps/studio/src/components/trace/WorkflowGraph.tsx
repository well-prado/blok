import { cn } from "@/lib/utils";
import { type DagEdge, type DagNode, type DagNodeKind, buildWorkflowDag } from "@/lib/workflowDag";
import { Link } from "@tanstack/react-router";
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
import {
	ArrowRightFromLine,
	CheckCircle2,
	Clock,
	GitBranch,
	Play,
	Repeat,
	RotateCw,
	Shield,
	ShieldX,
	Split,
	Wrench,
} from "lucide-react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";

interface WorkflowGraphProps {
	/**
	 * The raw workflow JSON returned by `/__blok/workflows/:name` as
	 * `detail.definition`. Accept `unknown` because the contract is
	 * intentionally open — `buildWorkflowDag` narrows defensively.
	 */
	definition: unknown;
}

const NODE_WIDTH = 200;
const NODE_HEIGHT = 60;
const MERGE_DIAMETER = 14;
const TERMINAL_DIAMETER = 80; // trigger / end pills

/**
 * Static workflow DAG visualizer (E4). Renders the structure of a
 * workflow before any run: trigger → steps → end with diamonds for
 * branches, back-edges for forEach/loop, and dedicated lanes for
 * tryCatch. Live runs use `TraceGraph` instead.
 */
export function WorkflowGraph({ definition }: WorkflowGraphProps) {
	const { nodes: flowNodes, edges: flowEdges } = useMemo(() => layoutDag(definition), [definition]);

	const nodeTypes = useMemo(
		() => ({
			trigger: TriggerNode,
			end: EndNode,
			regular: RegularNode,
			subworkflow: SubworkflowNode,
			wait: WaitNode,
			branch: DecisionNode,
			switch: SwitchNode,
			forEach: IterationNode,
			loop: LoopNode,
			tryEnter: TryNode,
			catchEnter: CatchNode,
			finallyEnter: FinallyNode,
			merge: MergeNode,
		}),
		[],
	);

	if (flowNodes.length === 0) {
		return null;
	}

	return (
		<div className="h-[600px] rounded-lg border border-zinc-800 overflow-hidden bg-canvas">
			<ReactFlow
				nodes={flowNodes}
				edges={flowEdges}
				nodeTypes={nodeTypes}
				fitView
				fitViewOptions={{ padding: 0.25 }}
				proOptions={{ hideAttribution: true }}
				minZoom={0.25}
				maxZoom={2}
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable={true}
			>
				<Background color="#27272a" gap={16} size={1} />
				<Controls
					showInteractive={false}
					className="bg-zinc-900! border-zinc-700! rounded-md! [&>button]:bg-zinc-800! [&>button]:border-zinc-700! [&>button]:text-zinc-400! [&>button:hover]:bg-zinc-700!"
				/>
				<MiniMap
					nodeStrokeColor="#3f3f46"
					nodeColor={(node) => MINIMAP_COLORS[(node.data as { kind: DagNodeKind }).kind] ?? "#52525b"}
					maskColor="rgba(0,0,0,0.6)"
					className="bg-zinc-900! border-zinc-700! rounded-md!"
				/>
			</ReactFlow>
		</div>
	);
}

// === Layout ===

const MINIMAP_COLORS: Partial<Record<DagNodeKind, string>> = {
	trigger: "#22c55e",
	end: "#71717a",
	regular: "#94a3b8",
	subworkflow: "#818cf8",
	wait: "#fbbf24",
	branch: "#fbbf24",
	switch: "#fb923c",
	forEach: "#a78bfa",
	loop: "#a78bfa",
	tryEnter: "#f87171",
	catchEnter: "#ef4444",
	finallyEnter: "#fb923c",
	merge: "#52525b",
};

function nodeSize(kind: DagNodeKind): { width: number; height: number } {
	if (kind === "merge") return { width: MERGE_DIAMETER, height: MERGE_DIAMETER };
	if (kind === "trigger" || kind === "end") return { width: TERMINAL_DIAMETER, height: 40 };
	return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

function layoutDag(definition: unknown): { nodes: Node[]; edges: Edge[] } {
	const dag = buildWorkflowDag(definition);

	const g = new dagre.graphlib.Graph();
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 60, acyclicer: "greedy" });

	for (const n of dag.nodes) {
		const { width, height } = nodeSize(n.data.kind);
		g.setNode(n.id, { width, height });
	}
	for (const e of dag.edges) {
		g.setEdge(e.source, e.target, { weight: e.backEdge ? 0 : 1 });
	}
	dagre.layout(g);

	const flowNodes: Node[] = dag.nodes.map((n) => {
		const pos = g.node(n.id) ?? { x: 0, y: 0 };
		const { width, height } = nodeSize(n.data.kind);
		// xyflow types Node.data as Record<string, unknown>. DagNodeData
		// is a closed shape, so we coerce at the boundary — the node
		// renderers narrow back via `asData` below.
		return {
			id: n.id,
			type: n.data.kind,
			position: { x: pos.x - width / 2, y: pos.y - height / 2 },
			data: n.data as unknown as Record<string, unknown>,
			draggable: false,
		};
	});

	const flowEdges: Edge[] = dag.edges.map((e) => toFlowEdge(e));

	return { nodes: flowNodes, edges: flowEdges };
}

function toFlowEdge(edge: DagEdge): Edge {
	const dashed = edge.style === "dashed" || edge.style === "dotted";
	return {
		id: edge.id,
		source: edge.source,
		target: edge.target,
		label: edge.label,
		labelStyle: { fill: "#a1a1aa", fontSize: 10 },
		labelBgStyle: { fill: "#18181b" },
		labelBgPadding: [4, 2],
		labelBgBorderRadius: 4,
		style: {
			stroke: edge.backEdge ? "#a78bfa" : "#3f3f46",
			strokeWidth: 1.5,
			strokeDasharray: dashed ? "4 4" : undefined,
		},
		type: edge.backEdge ? "default" : "smoothstep",
	};
}

// === Node renderers ===

// Lucide accepts a generic SVG icon component. Type the renderer prop
// loosely (LucideIcon) and cap consumers to the icons we import above.
type IconComponent = typeof Play;

interface NodeShellProps {
	icon: IconComponent;
	iconClass: string;
	title: string;
	subtitle?: string;
	accent: string;
}

function NodeShell({ icon: Icon, iconClass, title, subtitle, accent }: NodeShellProps) {
	return (
		<div
			className={cn(
				"rounded-md border bg-zinc-900 px-3 py-2 min-w-[180px] max-w-[220px] transition-colors hover:border-zinc-600",
				accent,
			)}
		>
			<div className="flex items-center gap-2">
				<Icon className={cn("w-3.5 h-3.5 shrink-0", iconClass)} />
				<span className="text-xs font-medium text-zinc-100 truncate">{title}</span>
			</div>
			{subtitle && <div className="text-[10px] text-zinc-500 mt-1 truncate font-mono">{subtitle}</div>}
		</div>
	);
}

function withHandles(content: React.ReactNode) {
	return (
		<>
			<Handle type="target" position={Position.Top} className="bg-zinc-600! w-2! h-2! border-0!" />
			{content}
			<Handle type="source" position={Position.Bottom} className="bg-zinc-600! w-2! h-2! border-0!" />
		</>
	);
}

function asData(props: NodeProps): DagNode["data"] {
	return props.data as unknown as DagNode["data"];
}

function TriggerNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<div className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 min-w-[120px] text-center">
			<div className="flex items-center justify-center gap-1.5">
				<Play className="w-3 h-3 text-emerald-400" />
				<span className="text-[11px] font-semibold text-emerald-200 truncate">{data.label}</span>
			</div>
			{data.sublabel && (
				<div className="text-[10px] text-emerald-400/70 mt-0.5 truncate font-mono">{data.sublabel}</div>
			)}
		</div>,
	);
}

function EndNode(props: NodeProps) {
	const data = asData(props);
	return (
		<>
			<Handle type="target" position={Position.Top} className="bg-zinc-600! w-2! h-2! border-0!" />
			<div className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 min-w-[80px] text-center">
				<div className="flex items-center justify-center gap-1.5">
					<CheckCircle2 className="w-3 h-3 text-zinc-400" />
					<span className="text-[11px] font-semibold text-zinc-300">{data.label}</span>
				</div>
			</div>
		</>
	);
}

function RegularNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Wrench}
			iconClass="text-zinc-400"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-zinc-700"
		/>,
	);
}

function SubworkflowNode(props: NodeProps) {
	const data = asData(props);
	const target = data.meta?.expression;
	// Only link out when the target is a literal workflow name, not a
	// $-expression or `js/...` resolved at runtime. The polymorphic case
	// can't navigate at design time.
	const isLiteral =
		typeof target === "string" &&
		!target.startsWith("$.") &&
		!target.startsWith("js/") &&
		!target.startsWith("{") &&
		target.length > 0;
	const inner = (
		<NodeShell
			icon={ArrowRightFromLine}
			iconClass="text-indigo-400"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-indigo-500/40"
		/>
	);
	return withHandles(
		isLiteral && target ? (
			<Link to="/workflows/$name" params={{ name: target }} className="block">
				{inner}
			</Link>
		) : (
			inner
		),
	);
}

function WaitNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Clock}
			iconClass="text-amber-300"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-amber-500/40"
		/>,
	);
}

function DecisionNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={GitBranch}
			iconClass="text-yellow-300"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-yellow-500/50"
		/>,
	);
}

function SwitchNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Split}
			iconClass="text-orange-300"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-orange-500/50"
		/>,
	);
}

function IterationNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Repeat}
			iconClass="text-violet-300"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-violet-500/50"
		/>,
	);
}

function LoopNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={RotateCw}
			iconClass="text-violet-300"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-violet-500/50"
		/>,
	);
}

function TryNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Shield}
			iconClass="text-red-300"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-red-500/40"
		/>,
	);
}

function CatchNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={ShieldX}
			iconClass="text-red-400"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-red-500/60"
		/>,
	);
}

function FinallyNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Shield}
			iconClass="text-orange-300"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-orange-500/40"
		/>,
	);
}

function MergeNode(_props: NodeProps) {
	return (
		<>
			<Handle type="target" position={Position.Top} className="bg-zinc-600! w-1.5! h-1.5! border-0!" />
			<div className="w-3 h-3 rounded-full bg-zinc-600 border border-zinc-500" />
			<Handle type="source" position={Position.Bottom} className="bg-zinc-600! w-1.5! h-1.5! border-0!" />
		</>
	);
}
