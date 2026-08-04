import { StatusBadge } from "@/components/shared/StatusBadge";
import { BrowserPanel } from "@/components/trace/BrowserPanel";
import { useRunDetail, useTraceStream } from "@/hooks/useRunDetail";
import { useSaveWorkflowStudio, useWorkflowStudio } from "@/hooks/useWorkflows";
import { ApiError, startTestRun } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type DagEdge, type DagNode, type DagNodeKind, buildWorkflowDag } from "@/lib/workflowDag";
import { withWorkflowNodePositions, workflowNodePosition } from "@/lib/workflowLayout";
import type { NodeRun, NodeRunStatus, WorkflowStudioConfig } from "@/types";
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
	type ReactFlowInstance,
	useNodesState,
} from "@xyflow/react";
import dagre from "dagre";
import {
	AlertTriangle,
	ArrowRightFromLine,
	CheckCircle2,
	Clock,
	Focus,
	GitBranch,
	Loader2,
	Maximize2,
	Pencil,
	Play,
	Repeat,
	RotateCcw,
	RotateCw,
	Save,
	Shield,
	ShieldX,
	Split,
	WandSparkles,
	Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";

interface WorkflowGraphProps {
	/**
	 * The raw workflow JSON returned by `/__blok/workflows/:name` as
	 * `detail.definition`. Accept `unknown` because the contract is
	 * intentionally open — `buildWorkflowDag` narrows defensively.
	 */
	definition: unknown;
	workflowName: string;
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
export function WorkflowGraph({ definition, workflowName }: WorkflowGraphProps) {
	const studioQuery = useWorkflowStudio(workflowName);
	const saveStudio = useSaveWorkflowStudio(workflowName);
	const [activeRunId, setActiveRunId] = useState("");
	const [startingRun, setStartingRun] = useState(false);
	const [runError, setRunError] = useState("");
	const runQuery = useRunDetail(activeRunId);
	useTraceStream(activeRunId);
	const committed = useMemo(
		() => layoutDag(definition, studioQuery.data?.config),
		[definition, studioQuery.data?.config],
	);
	const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(committed.nodes);
	const [editing, setEditing] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
	const [workspaceMode, setWorkspaceMode] = useState<"canvas" | "split" | "browser">("canvas");
	const canvasRef = useRef<HTMLDivElement>(null);
	const writable = studioQuery.data?.writable === true;
	const autoOpenBrowser = runQuery.data?.browserSession?.autoOpen ? runQuery.data.browserSession.sessionId : undefined;
	const liveStatuses = useMemo(() => projectNodeStatuses(runQuery.data?.nodes ?? []), [runQuery.data?.nodes]);
	const renderedNodes = useMemo(
		() =>
			flowNodes.map((node) => {
				const status = liveStatuses[flowNodeStepId(node) ?? ""];
				return status ? { ...node, data: { ...node.data, liveStatus: status } } : node;
			}),
		[flowNodes, liveStatuses],
	);
	const renderedEdges = useMemo(
		() => projectEdgeStatuses(committed.edges, renderedNodes),
		[committed.edges, renderedNodes],
	);
	const activeStepId = useMemo(
		() =>
			[...(runQuery.data?.nodes ?? [])]
				.filter((node) => node.status === "running")
				.sort((a, b) => b.startedAt - a.startedAt)[0]?.nodeName,
		[runQuery.data?.nodes],
	);
	const activeNode = useMemo(
		() => renderedNodes.find((node) => flowNodeStepId(node) === activeStepId),
		[activeStepId, renderedNodes],
	);

	useEffect(() => {
		setFlowNodes(committed.nodes);
		setDirty(false);
	}, [committed.nodes, setFlowNodes]);

	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	useEffect(() => {
		if (!activeNode || !flowInstance || !canvasRef.current) return;
		const { x, y, zoom } = flowInstance.getViewport();
		const width = activeNode.measured?.width ?? nodeSize((activeNode.data as unknown as LiveDagNodeData).kind).width;
		const height = activeNode.measured?.height ?? nodeSize((activeNode.data as unknown as LiveDagNodeData).kind).height;
		const left = activeNode.position.x * zoom + x;
		const top = activeNode.position.y * zoom + y;
		const margin = 24;
		const visible =
			left + width * zoom >= margin &&
			top + height * zoom >= margin &&
			left <= canvasRef.current.clientWidth - margin &&
			top <= canvasRef.current.clientHeight - margin;
		if (!visible) flowInstance.fitView({ nodes: [{ id: activeNode.id }], padding: 1, duration: 300, maxZoom: 1.2 });
	}, [activeNode, flowInstance]);

	useEffect(() => {
		if (autoOpenBrowser) setWorkspaceMode("split");
	}, [autoOpenBrowser]);

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

	const discard = () => {
		setFlowNodes(committed.nodes);
		setDirty(false);
		setEditing(false);
		saveStudio.reset();
	};
	const autoLayout = () => {
		setFlowNodes(layoutDag(definition, studioQuery.data?.config, { ignorePositions: true }).nodes);
		setDirty(true);
	};
	const save = () => {
		if (!studioQuery.data || !dirty) return;
		const config = withWorkflowNodePositions(
			studioQuery.data.config,
			workflowName,
			flowNodes.map((node) => ({ stepId: flowNodeStepId(node), position: node.position })),
		);
		saveStudio.mutate(
			{ config, baseEtag: studioQuery.data.etag },
			{
				onSuccess: () => {
					setDirty(false);
					setEditing(false);
				},
			},
		);
	};
	const conflict = saveStudio.error instanceof ApiError && saveStudio.error.status === 409;
	const runStatus = runQuery.data?.run.status;
	const runActive =
		runStatus === "pending" || runStatus === "queued" || runStatus === "delayed" || runStatus === "running";
	const run = async () => {
		setStartingRun(true);
		setRunError("");
		try {
			setActiveRunId((await startTestRun(workflowName)).runId);
		} catch (error) {
			setRunError(error instanceof Error ? error.message : "Could not start workflow");
		} finally {
			setStartingRun(false);
		}
	};
	const fitActive = () => {
		if (activeNode) flowInstance?.fitView({ nodes: [{ id: activeNode.id }], padding: 1, duration: 300, maxZoom: 1.2 });
	};

	return (
		<div className="rounded-lg border border-zinc-800 overflow-hidden bg-canvas">
			<div className="min-h-12 flex items-center gap-3 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="text-xs font-semibold text-zinc-200">Canvas layout</span>
						{dirty && <span className="text-[10px] font-medium text-amber-300">● Unsaved</span>}
						{studioQuery.isLoading && <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />}
					</div>
					<p className="truncate text-[10px] text-zinc-500">
						{editing
							? "Drag workflow steps, then save their positions beside the workflow source."
							: studioQuery.data?.sourcePath ||
								studioQuery.data?.readOnlyReason ||
								studioQuery.error?.message ||
								"Loading layout source…"}
					</p>
				</div>
				{activeRunId && runStatus && (
					<Link to="/runs/$runId" params={{ runId: activeRunId }} title="Open run details">
						<StatusBadge status={runStatus} />
					</Link>
				)}
				{runQuery.data?.browserSession && (
					<div className="flex rounded-md border border-zinc-700 p-0.5" aria-label="Workspace focus">
						{(["canvas", "split", "browser"] as const).map((mode) => (
							<button
								type="button"
								key={mode}
								onClick={() => setWorkspaceMode(mode)}
								className={cn(
									"rounded px-2 py-1 text-[10px] font-medium capitalize text-zinc-500 hover:text-zinc-200",
									workspaceMode === mode && "bg-zinc-700 text-zinc-100",
								)}
							>
								{mode}
							</button>
						))}
					</div>
				)}
				{editing ? (
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							onClick={autoLayout}
							className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
						>
							<WandSparkles className="h-3.5 w-3.5" /> Auto layout
						</button>
						<button
							type="button"
							onClick={discard}
							className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
						>
							<RotateCcw className="h-3.5 w-3.5" /> Discard
						</button>
						<button
							type="button"
							onClick={save}
							disabled={!dirty || saveStudio.isPending}
							className="inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-3 py-1.5 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
						>
							{saveStudio.isPending ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Save className="h-3.5 w-3.5" />
							)}
							Save
						</button>
					</div>
				) : (
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							onClick={fitActive}
							disabled={!activeNode}
							title="Fit active node"
							aria-label="Fit active node"
							className="inline-flex items-center rounded-md border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
						>
							<Focus className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							onClick={() => flowInstance?.fitView({ padding: 0.25, duration: 300 })}
							title="Fit workflow"
							aria-label="Fit workflow"
							className="inline-flex items-center rounded-md border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
						>
							<Maximize2 className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							onClick={() => setEditing(true)}
							disabled={!writable || studioQuery.isLoading || runActive}
							title={studioQuery.data?.readOnlyReason}
							className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
						>
							<Pencil className="h-3.5 w-3.5" /> {writable ? "Edit layout" : "Read only"}
						</button>
						<button
							type="button"
							onClick={run}
							disabled={startingRun || runActive}
							className="inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-3 py-1.5 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
						>
							{startingRun || runActive ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Play className="h-3.5 w-3.5" />
							)}
							{runActive ? "Running" : "Run"}
						</button>
					</div>
				)}
			</div>
			{runError && (
				<div
					role="alert"
					className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200"
				>
					<AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {runError}
				</div>
			)}
			{saveStudio.error && (
				<div
					role="alert"
					className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
				>
					<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
					<span className="flex-1">
						{conflict ? "This layout changed on disk after you opened it." : saveStudio.error.message}
					</span>
					{conflict && (
						<button
							type="button"
							onClick={() => {
								studioQuery.refetch();
								setEditing(false);
								saveStudio.reset();
							}}
							className="rounded px-2 py-1 font-medium hover:bg-amber-500/15"
						>
							Reload layout
						</button>
					)}
				</div>
			)}
			<div className={cn("grid", workspaceMode === "split" && "lg:grid-cols-2")}>
				<div ref={canvasRef} className={cn("h-[600px] min-w-0", workspaceMode === "browser" && "hidden")}>
					<ReactFlow
						nodes={renderedNodes}
						edges={renderedEdges}
						onInit={setFlowInstance}
						onNodesChange={onNodesChange}
						onNodeDragStop={(_event, node) => {
							if (editing && flowNodeStepId(node)) setDirty(true);
						}}
						nodeTypes={nodeTypes}
						fitView
						fitViewOptions={{ padding: 0.25 }}
						proOptions={{ hideAttribution: true }}
						minZoom={0.25}
						maxZoom={2}
						nodesDraggable={editing && writable}
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
				{runQuery.data?.browserSession && workspaceMode !== "canvas" && (
					<BrowserPanel
						session={runQuery.data.browserSession}
						events={runQuery.data.browserEvents ?? []}
						className="h-[600px] min-w-0 border-l border-zinc-800"
					/>
				)}
			</div>
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

/**
 * Inline-layout pin (#410/#411). A persisted position lives at
 * `step.ui.{x,y}` and rides through normalization on the raw step
 * (`copyUi` in WorkflowNormalizer). We pin ONLY nodes that carry a real
 * `meta.stepId` — synthetic nodes (merge/trigger/end/tryEnter/…) have no
 * stepId, so they always fall through to dagre auto-layout. A stale ui on
 * a now-deleted step simply never matches a node, so it's ignored; a
 * missing/garbage ui degrades to dagre. The returned position is the
 * top-left in xyflow space (dagre centers, so callers offset by half-size).
 */
export function pinnedPosition(node: DagNode): { x: number; y: number } | undefined {
	if (typeof node.data.meta?.stepId !== "string") return undefined;
	const raw = node.data.meta.raw;
	if (typeof raw !== "object" || raw === null) return undefined;
	const ui = (raw as { ui?: unknown }).ui;
	if (typeof ui !== "object" || ui === null) return undefined;
	const { x, y } = ui as { x?: unknown; y?: unknown };
	if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
		return undefined;
	}
	return { x, y };
}

function flowNodeStepId(node: Pick<Node, "data">): string | undefined {
	const stepId = (node.data as unknown as DagNode["data"]).meta?.stepId;
	return typeof stepId === "string" ? stepId : undefined;
}

type LiveDagNodeData = DagNode["data"] & { liveStatus?: NodeRunStatus };

/** Collapse repeated loop executions to the latest state for each static step. */
export function projectNodeStatuses(nodes: NodeRun[]): Record<string, NodeRunStatus> {
	const latest = new Map<string, NodeRun>();
	for (const node of nodes) {
		const current = latest.get(node.nodeName);
		if (!current || node.startedAt >= current.startedAt) latest.set(node.nodeName, node);
	}
	return Object.fromEntries([...latest].map(([stepId, node]) => [stepId, node.status]));
}

function projectEdgeStatuses(edges: Edge[], nodes: Node[]): Edge[] {
	const statusByNode = new Map(nodes.map((node) => [node.id, (node.data as unknown as LiveDagNodeData).liveStatus]));
	return edges.map((edge) => {
		const targetStatus = statusByNode.get(edge.target);
		const active = targetStatus === "running";
		const stroke = targetStatus === "failed" ? "#f87171" : targetStatus === "completed" ? "#4ade80" : undefined;
		return {
			...edge,
			animated: active,
			style: active
				? { ...edge.style, stroke: "#60a5fa", strokeWidth: 2 }
				: stroke
					? { ...edge.style, stroke }
					: edge.style,
		};
	});
}

function persistedPosition(
	node: DagNode,
	config: WorkflowStudioConfig | null | undefined,
): { x: number; y: number } | undefined {
	const stepId = node.data.meta?.stepId;
	return workflowNodePosition(typeof stepId === "string" ? config?.nodes[stepId] : undefined) ?? pinnedPosition(node);
}

export function layoutDag(
	definition: unknown,
	config?: WorkflowStudioConfig | null,
	options?: { ignorePositions?: boolean },
): { nodes: Node[]; edges: Edge[] } {
	const dag = buildWorkflowDag(definition);

	const g = new dagre.graphlib.Graph();
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({ rankdir: config?.canvas?.direction ?? "TB", nodesep: 40, ranksep: 60, acyclicer: "greedy" });

	const pins = new Map<string, { x: number; y: number }>();
	for (const n of dag.nodes) {
		const { width, height } = nodeSize(n.data.kind);
		const pin = options?.ignorePositions ? undefined : persistedPosition(n, config);
		if (pin) {
			pins.set(n.id, pin);
			// Seed dagre with the pinned center so neighbouring auto nodes
			// rank around it instead of stacking at the origin.
			g.setNode(n.id, { width, height, x: pin.x + width / 2, y: pin.y + height / 2 });
		} else {
			g.setNode(n.id, { width, height });
		}
	}
	for (const e of dag.edges) {
		g.setEdge(e.source, e.target, { weight: e.backEdge ? 0 : 1 });
	}
	dagre.layout(g);

	const flowNodes: Node[] = dag.nodes.map((n) => {
		const { width, height } = nodeSize(n.data.kind);
		const pin = pins.get(n.id);
		// Pin wins over dagre's computed position so a structural edit
		// (insert/delete upstream → dagre re-runs) does not snap a
		// manually-placed node back. Seed-only would still move it.
		const pos = pin ?? g.node(n.id) ?? { x: 0, y: 0 };
		// xyflow types Node.data as Record<string, unknown>. DagNodeData
		// is a closed shape, so we coerce at the boundary — the node
		// renderers narrow back via `asData` below.
		return {
			id: n.id,
			type: n.data.kind,
			position: pin ? { x: pin.x, y: pin.y } : { x: pos.x - width / 2, y: pos.y - height / 2 },
			data: n.data as unknown as Record<string, unknown>,
			draggable: typeof n.data.meta?.stepId === "string" ? undefined : false,
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
	status?: NodeRunStatus;
}

function NodeShell({ icon: Icon, iconClass, title, subtitle, accent, status }: NodeShellProps) {
	return (
		<div
			className={cn(
				"rounded-md border bg-zinc-900 px-3 py-2 min-w-[180px] max-w-[220px] transition-colors hover:border-zinc-600",
				accent,
				status === "running" &&
					"border-blue-400 shadow-[0_0_0_1px_#60a5fa,0_0_20px_rgba(96,165,250,0.3)] animate-pulse",
				status === "completed" && "border-green-400/80 bg-green-500/10",
				status === "failed" && "border-red-400 bg-red-500/10",
				status === "skipped" && "opacity-50",
			)}
		>
			<div className="flex items-center gap-2">
				<Icon className={cn("w-3.5 h-3.5 shrink-0", iconClass)} />
				<span className="text-xs font-medium text-zinc-100 truncate">{title}</span>
				{status && (
					<span
						className={cn(
							"ml-auto h-2 w-2 shrink-0 rounded-full",
							status === "running" && "bg-blue-400",
							status === "completed" && "bg-green-400",
							status === "failed" && "bg-red-400",
							status === "skipped" && "bg-zinc-500",
							status === "pending" && "bg-zinc-400",
						)}
						title={status}
					/>
				)}
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

function asData(props: NodeProps): LiveDagNodeData {
	return props.data as unknown as LiveDagNodeData;
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
			status={data.liveStatus}
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
			status={data.liveStatus}
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
			status={data.liveStatus}
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
			status={data.liveStatus}
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
			status={data.liveStatus}
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
			status={data.liveStatus}
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
			status={data.liveStatus}
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
			status={data.liveStatus}
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
			status={data.liveStatus}
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
			status={data.liveStatus}
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
