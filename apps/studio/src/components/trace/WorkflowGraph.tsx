import { StatusBadge } from "@/components/shared/StatusBadge";
import { ActivityDrawer } from "@/components/trace/ActivityDrawer";
import { BrowserPanel } from "@/components/trace/BrowserPanel";
import { StepInputsEditor } from "@/components/trace/StepInputsEditor";
import { useRunDetail, useTraceStream } from "@/hooks/useRunDetail";
import {
	useEditWorkflowDefinition,
	useNodeCatalog,
	useSaveWorkflowStudio,
	useWorkflowStudio,
} from "@/hooks/useWorkflows";
import { ApiError, type NodeCatalogEntry, type StartTestRunRequest, controlDebugRun, startTestRun } from "@/lib/api";
import { deleteStep, findStepLocation, insertStep, nextId, renameStep } from "@/lib/irEditOps";
import { cn } from "@/lib/utils";
import { type DagEdge, type DagNode, type DagNodeKind, buildWorkflowDag } from "@/lib/workflowDag";
import { withWorkflowNodePositions, workflowNodePosition } from "@/lib/workflowLayout";
import type { BrowserArtifact, NodeRun, NodeRunStatus, WorkflowStudioConfig } from "@/types";
import { Link } from "@tanstack/react-router";
import {
	Background,
	Controls,
	type Edge,
	Handle,
	MarkerType,
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
	Bug,
	CheckCircle2,
	Clock,
	FastForward,
	Focus,
	GitBranch,
	Loader2,
	Maximize2,
	Pencil,
	Play,
	Plus,
	Repeat,
	RotateCcw,
	RotateCw,
	Save,
	Shield,
	ShieldX,
	SkipForward,
	Split,
	Square,
	Trash2,
	WandSparkles,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const NODE_WIDTH = 260;
const NODE_HEIGHT = 104; // step cards with config rows
const FLOW_NODE_HEIGHT = 64; // dashed control-flow cards (header + condition)
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
	const editDefinition = useEditWorkflowDefinition(workflowName);
	const [activeRunId, setActiveRunId] = useState("");
	const [startingRun, setStartingRun] = useState(false);
	const [runError, setRunError] = useState("");
	const [launchMode, setLaunchMode] = useState<"run" | "debug" | "step">("run");
	const [breakpoints, setBreakpoints] = useState<Set<string>>(() => new Set());
	const [controlPending, setControlPending] = useState(false);
	const [renamingStepId, setRenamingStepId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [paletteSearch, setPaletteSearch] = useState("");
	const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
	const [editingInputsStepId, setEditingInputsStepId] = useState<string | null>(null);
	const catalog = useNodeCatalog(paletteOpen || editingInputsStepId !== null);
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
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [selectedArtifact, setSelectedArtifact] = useState<BrowserArtifact>();
	const canvasRef = useRef<HTMLDivElement>(null);
	const writable = studioQuery.data?.writable === true;
	// Phase 5.4 — structural edits only apply to Studio-saveable v2 JSON
	// workflows; TS sources stay layout/run/debug-only.
	const definitionEditable = writable && (studioQuery.data?.sourcePath?.endsWith(".json") ?? false);
	const autoOpenBrowser = runQuery.data?.browserSession?.autoOpen ? runQuery.data.browserSession.sessionId : undefined;
	const liveStatuses = useMemo(() => projectNodeStatuses(runQuery.data?.nodes ?? []), [runQuery.data?.nodes]);
	const runStatus = runQuery.data?.run.status;
	const controlledRunId = activeRunId || runQuery.data?.run.id || "";
	const pausedEvent = useMemo(
		() =>
			runStatus === "paused"
				? [...(runQuery.data?.events ?? [])].reverse().find((event) => event.type === "RUN_PAUSED")
				: undefined,
		[runQuery.data?.events, runStatus],
	);
	const pausedPayload =
		(pausedEvent?.payload as { stepId?: string; inputs?: unknown } | undefined) ?? runQuery.data?.debugPause;
	const stepUses = useMemo(
		() =>
			Object.fromEntries(
				committed.nodes.flatMap((node) => {
					const data = node.data as unknown as DagNode["data"];
					return data.meta?.stepId && data.meta.nodeRef ? [[data.meta.stepId, data.meta.nodeRef]] : [];
				}),
			),
		[committed.nodes],
	);
	const renderedNodes = useMemo(
		() =>
			flowNodes.map((node) => {
				const stepId = flowNodeStepId(node);
				const status = liveStatuses[stepId ?? ""];
				return {
					...node,
					className: cn(
						node.className,
						stepId &&
							breakpoints.has(stepId) &&
							"after:absolute after:-left-1 after:-top-1 after:h-3 after:w-3 after:rounded-full after:border-2 after:border-zinc-950 after:bg-red-500",
						stepId !== undefined &&
							stepId === pausedPayload?.stepId &&
							"rounded-lg ring-2 ring-amber-300 ring-offset-4 ring-offset-zinc-950",
					),
					data: status ? { ...node.data, liveStatus: status } : node.data,
				};
			}),
		[breakpoints, flowNodes, liveStatuses, pausedPayload?.stepId],
	);
	const renderedEdges = useMemo(
		() => projectEdgeStatuses(committed.edges, renderedNodes),
		[committed.edges, renderedNodes],
	);
	const activeStepId = useMemo(
		() =>
			[...(runQuery.data?.nodes ?? [])]
				.filter((node) => node.status === "running")
				.sort((a, b) => b.startedAt - a.startedAt)[0]?.nodeName ?? pausedPayload?.stepId,
		[pausedPayload?.stepId, runQuery.data?.nodes],
	);
	const activeNode = useMemo(
		() => renderedNodes.find((node) => flowNodeStepId(node) === activeStepId),
		[activeStepId, renderedNodes],
	);
	const selectedCanvasStepId = useMemo(() => {
		const selected = flowNodes.find((node) => node.selected);
		return selected ? flowNodeStepId(selected) : undefined;
	}, [flowNodes]);

	useEffect(() => {
		setFlowNodes(committed.nodes);
		setDirty(false);
	}, [committed.nodes, setFlowNodes]);

	// The `fitView` prop fires once at mount, which races page layout now
	// that Canvas is the default tab (a degenerate container yields a ~1:1
	// viewport on large graphs). Re-fit explicitly once the instance exists
	// and whenever the committed graph changes, after layout has settled.
	// biome-ignore lint/correctness/useExhaustiveDependencies: committed.nodes intentionally re-fires the fit on graph changes
	useEffect(() => {
		if (!flowInstance) return;
		const frame = requestAnimationFrame(() => {
			requestAnimationFrame(() => void flowInstance.fitView({ padding: 0.2 }));
		});
		return () => cancelAnimationFrame(frame);
	}, [flowInstance, committed.nodes]);

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
	const runActive =
		runStatus === "pending" ||
		runStatus === "queued" ||
		runStatus === "delayed" ||
		runStatus === "running" ||
		runStatus === "paused";
	const launch = async (request?: StartTestRunRequest) => {
		setStartingRun(true);
		setRunError("");
		setSelectedNodeId(null);
		setSelectedArtifact(undefined);
		try {
			setActiveRunId((await (request ? startTestRun(workflowName, request) : startTestRun(workflowName))).runId);
		} catch (error) {
			setRunError(error instanceof Error ? error.message : "Could not start workflow");
		} finally {
			setStartingRun(false);
		}
	};
	const run = () =>
		launch(
			launchMode === "run" ? undefined : { mode: "debug", breakpoints: launchMode === "debug" ? [...breakpoints] : [] },
		);
	// Phase 4.3 "Run to here" — fresh debug run that flows straight to the
	// selected node (no entry pause) and pauses before it executes.
	const runToNode = (stepId: string) => launch({ mode: "debug", breakpoints: [stepId], stopOnEntry: false });
	const sendControl = useCallback(
		async (action: "continue" | "step" | "stop") => {
			if (!controlledRunId || runStatus !== "paused" || controlPending) return;
			setControlPending(true);
			setRunError("");
			try {
				await controlDebugRun(controlledRunId, action);
			} catch (error) {
				setRunError(error instanceof Error ? error.message : `Could not ${action} workflow`);
			} finally {
				setControlPending(false);
			}
		},
		[controlledRunId, controlPending, runStatus],
	);
	useEffect(() => {
		if (runStatus !== "paused") return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
			const action =
				event.key === "F8"
					? "continue"
					: event.key === "F10"
						? "step"
						: event.shiftKey && event.key === "F5"
							? "stop"
							: null;
			if (!action) return;
			event.preventDefault();
			void sendControl(action);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [runStatus, sendControl]);
	const toggleBreakpointId = (stepId: string) => {
		setBreakpoints((current) => {
			const next = new Set(current);
			if (next.has(stepId)) next.delete(stepId);
			else next.add(stepId);
			return next;
		});
	};
	const toggleBreakpoint = (node: Node) => {
		if (editing) return;
		const stepId = flowNodeStepId(node);
		if (stepId) toggleBreakpointId(stepId);
	};
	const fitActive = () => {
		if (activeNode) flowInstance?.fitView({ nodes: [{ id: activeNode.id }], padding: 1, duration: 300, maxZoom: 1.2 });
	};
	const startRename = (stepId: string) => {
		editDefinition.reset();
		setPaletteOpen(false);
		setEditingInputsStepId(null);
		setRenamingStepId(stepId);
		setRenameValue(stepId);
	};
	// Phase 5.3 — open the schema-driven inputs editor for the selected step.
	const startEditInputs = (stepId: string) => {
		editDefinition.reset();
		setPaletteOpen(false);
		setRenamingStepId(null);
		setEditingInputsStepId(stepId);
	};
	const saveInputs = (stepId: string, inputs: Record<string, unknown>) => {
		editDefinition.mutate(
			(definition) => {
				const draft = structuredClone(definition);
				const loc = findStepLocation(draft, stepId);
				if (!loc) throw new Error(`Step "${stepId}" no longer exists in the workflow`);
				loc.step.inputs = inputs;
				return draft;
			},
			{ onSuccess: () => setEditingInputsStepId(null) },
		);
	};
	// Phase 5.2 — insert the picked catalog node as a fresh step. Lands after
	// the selected step when that step is top-level; otherwise appends at the
	// end. Arm-targeted insertion arrives with edge-click insertion.
	const insertNode = (entry: NodeCatalogEntry) => {
		const anchor = selectedCanvasStepId;
		editDefinition.mutate(
			(definition) => {
				const steps = Array.isArray(definition.steps) ? (definition.steps as unknown[]) : [];
				const loc = anchor ? findStepLocation(definition, anchor) : null;
				const index = loc && loc.parentArray === steps ? loc.index + 1 : steps.length;
				const base = entry.name.includes("/") ? (entry.name.split("/").pop() as string) : entry.name;
				return insertStep(definition, { topLevel: true }, index, {
					id: nextId(definition, base),
					use: entry.ref,
					inputs: {},
				});
			},
			{ onSuccess: () => setPaletteOpen(false) },
		);
	};
	const removeStep = (stepId: string) => {
		editDefinition.mutate((definition) => deleteStep(definition, stepId), {
			onSuccess: () => setConfirmingDelete(null),
		});
	};
	const submitRename = () => {
		const oldId = renamingStepId;
		const newId = renameValue.trim();
		if (!oldId) return;
		if (newId === oldId || newId === "") {
			setRenamingStepId(null);
			return;
		}
		editDefinition.mutate((definition) => renameStep(definition, oldId, newId), {
			onSuccess: () => {
				setRenamingStepId(null);
				setBreakpoints((current) => {
					if (!current.has(oldId)) return current;
					const next = new Set(current);
					next.delete(oldId);
					next.add(newId);
					return next;
				});
			},
		});
	};
	const selectCanvasNode = (node: Node) => {
		const stepId = flowNodeStepId(node);
		if (!stepId) return;
		const nodeRun = [...(runQuery.data?.nodes ?? [])]
			.sort((a, b) => b.startedAt - a.startedAt)
			.find((candidate) => candidate.nodeName === stepId);
		if (nodeRun) {
			setSelectedNodeId(nodeRun.id);
			setSelectedArtifact(undefined);
		}
	};
	if (flowNodes.length === 0) return null;

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
						{!editing && launchMode === "debug"
							? `Double-click executable nodes to toggle breakpoints · ${breakpoints.size} set`
							: editing
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
						{definitionEditable && !runActive && (
							<button
								type="button"
								onClick={() => {
									editDefinition.reset();
									setPaletteOpen((open) => !open);
								}}
								disabled={editDefinition.isPending}
								title={
									selectedCanvasStepId ? `Insert a step after ${selectedCanvasStepId}` : "Append a step to the workflow"
								}
								className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
							>
								<Plus className="h-3.5 w-3.5 shrink-0" /> Add step
							</button>
						)}
						{selectedCanvasStepId && !runActive && (
							<>
								{definitionEditable && (
									<>
										<button
											type="button"
											onClick={() => startEditInputs(selectedCanvasStepId)}
											disabled={editDefinition.isPending}
											title={`Edit the inputs of ${selectedCanvasStepId}`}
											className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
										>
											<Wrench className="h-3.5 w-3.5 shrink-0" /> Edit inputs
										</button>
										<button
											type="button"
											onClick={() => startRename(selectedCanvasStepId)}
											disabled={editDefinition.isPending}
											title={`Rename step ${selectedCanvasStepId} and rewrite downstream references`}
											className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
										>
											<Pencil className="h-3.5 w-3.5 shrink-0" /> Rename
										</button>
										<button
											type="button"
											onClick={() =>
												confirmingDelete === selectedCanvasStepId
													? removeStep(selectedCanvasStepId)
													: setConfirmingDelete(selectedCanvasStepId)
											}
											disabled={editDefinition.isPending}
											title={`Delete step ${selectedCanvasStepId}`}
											className={cn(
												"inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40",
												confirmingDelete === selectedCanvasStepId
													? "border-red-400/60 bg-red-500/15 text-red-200 hover:bg-red-500/25"
													: "border-zinc-700 text-zinc-300 hover:bg-zinc-800",
											)}
										>
											<Trash2 className="h-3.5 w-3.5 shrink-0" />
											{confirmingDelete === selectedCanvasStepId ? "Confirm delete" : "Delete"}
										</button>
									</>
								)}
								<button
									type="button"
									onClick={() => runToNode(selectedCanvasStepId)}
									disabled={startingRun}
									title={`Start a debug run and pause before ${selectedCanvasStepId}`}
									className="inline-flex max-w-56 items-center gap-1.5 rounded-md border border-amber-400/50 px-2.5 py-1.5 text-xs text-amber-200 hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-40"
								>
									<FastForward className="h-3.5 w-3.5 shrink-0" />
									<span className="truncate">Run to {selectedCanvasStepId}</span>
								</button>
							</>
						)}
						<div className="flex overflow-hidden rounded-md border border-blok-green-500/50">
							<select
								aria-label="Run mode"
								value={launchMode}
								onChange={(event) => setLaunchMode(event.target.value as typeof launchMode)}
								disabled={startingRun || runActive}
								className="border-r border-blok-green-500/40 bg-zinc-900 px-2 text-[10px] font-medium text-zinc-300 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400 focus-visible:ring-inset disabled:opacity-40"
							>
								<option value="run">Run</option>
								<option value="debug">Debug</option>
								<option value="step">Step-through</option>
							</select>
							<button
								type="button"
								onClick={run}
								disabled={startingRun || runActive}
								className="inline-flex items-center gap-1.5 bg-blok-green-500 px-3 py-1.5 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
							>
								{startingRun || runActive ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : launchMode === "run" ? (
									<Play className="h-3.5 w-3.5" />
								) : (
									<Bug className="h-3.5 w-3.5" />
								)}
								{runActive
									? "Running"
									: launchMode === "step"
										? "Step-through"
										: launchMode === "debug"
											? "Debug"
											: "Run"}
							</button>
						</div>
					</div>
				)}
			</div>
			{paletteOpen && !runActive && (
				<div className="border-b border-zinc-800 bg-zinc-950/70 px-3 py-2">
					<div className="flex items-center gap-2">
						<input
							aria-label="Search nodes"
							placeholder="Search nodes…"
							value={paletteSearch}
							onChange={(event) => setPaletteSearch(event.target.value)}
							// biome-ignore lint/a11y/noAutofocus: focus follows the explicit Add step action
							autoFocus
							spellCheck={false}
							className="w-72 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
						/>
						<span className="text-[10px] text-zinc-500">
							{selectedCanvasStepId ? `Inserts after ${selectedCanvasStepId}` : "Appends at the end"}
						</span>
						<button
							type="button"
							onClick={() => setPaletteOpen(false)}
							className="ml-auto rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
						>
							Close
						</button>
					</div>
					{catalog.isLoading && <p className="mt-2 text-xs text-zinc-500">Loading node catalog…</p>}
					{catalog.error && <p className="mt-2 text-xs text-red-300">{catalog.error.message}</p>}
					{editDefinition.error && <p className="mt-2 text-xs text-red-300">{editDefinition.error.message}</p>}
					{catalog.data && (
						<ul className="mt-2 grid max-h-56 grid-cols-1 gap-1 overflow-y-auto md:grid-cols-2 xl:grid-cols-3">
							{catalog.data.nodes
								.filter((entry) => {
									const q = paletteSearch.trim().toLowerCase();
									if (!q) return true;
									return `${entry.ref} ${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(q);
								})
								.map((entry) => (
									<li key={entry.ref}>
										<button
											type="button"
											onClick={() => insertNode(entry)}
											disabled={editDefinition.isPending}
											className="w-full rounded-md border border-zinc-800 px-2.5 py-1.5 text-left hover:border-zinc-600 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
										>
											<span className="block truncate font-mono text-xs text-zinc-200">{entry.name}</span>
											<span className="block truncate text-[10px] text-zinc-500">{entry.description || entry.ref}</span>
										</button>
									</li>
								))}
						</ul>
					)}
				</div>
			)}
			{editingInputsStepId && !runActive && catalog.data && (
				<StepInputsEditor
					key={editingInputsStepId}
					stepId={editingInputsStepId}
					schema={catalog.data.nodes.find((entry) => entry.ref === stepUses[editingInputsStepId])?.inputSchema}
					inputs={
						((findStepLocation(definition, editingInputsStepId)?.step.inputs ?? {}) as Record<string, unknown>) ?? {}
					}
					pending={editDefinition.isPending}
					error={editDefinition.error?.message}
					onSave={(inputs) => saveInputs(editingInputsStepId, inputs)}
					onClose={() => setEditingInputsStepId(null)}
				/>
			)}
			{renamingStepId && (
				<form
					className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950/70 px-3 py-2"
					onSubmit={(event) => {
						event.preventDefault();
						submitRename();
					}}
				>
					<label htmlFor="rename-step-input" className="text-xs font-medium text-zinc-300">
						Rename <span className="font-mono">{renamingStepId}</span> to
					</label>
					<input
						id="rename-step-input"
						value={renameValue}
						onChange={(event) => setRenameValue(event.target.value)}
						// biome-ignore lint/a11y/noAutofocus: focus follows the explicit Rename action
						autoFocus
						spellCheck={false}
						className="w-56 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
					/>
					<button
						type="submit"
						disabled={editDefinition.isPending}
						className="inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-2.5 py-1 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{editDefinition.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save
					</button>
					<button
						type="button"
						onClick={() => setRenamingStepId(null)}
						className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
					>
						Cancel
					</button>
					<span className="text-[10px] text-zinc-500">Downstream references update automatically.</span>
					{editDefinition.error && <span className="text-xs text-red-300">{editDefinition.error.message}</span>}
				</form>
			)}
			{launchMode === "debug" && !editing && !runActive && (
				<fieldset className="flex flex-wrap items-center gap-1.5 border-x-0 border-t-0 border-b border-zinc-800 bg-zinc-950/70 px-3 py-1.5">
					<legend className="sr-only">Workflow breakpoints</legend>
					<span aria-hidden="true" className="mr-1 text-[10px] font-medium text-zinc-500">
						Breakpoints
					</span>
					{committed.nodes.flatMap((node) => {
						const stepId = flowNodeStepId(node);
						if (!stepId) return [];
						return (
							<button
								type="button"
								key={stepId}
								aria-pressed={breakpoints.has(stepId)}
								onClick={() => toggleBreakpointId(stepId)}
								className={cn(
									"rounded-full border px-2 py-0.5 font-mono text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300",
									breakpoints.has(stepId)
										? "border-red-400/50 bg-red-500/15 text-red-200"
										: "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300",
								)}
							>
								{stepId}
							</button>
						);
					})}
				</fieldset>
			)}
			{runError && (
				<div
					role="alert"
					className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200"
				>
					<AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {runError}
				</div>
			)}
			{runStatus === "paused" && (
				<div
					role="toolbar"
					aria-label="Debug controls"
					className="flex flex-wrap items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 py-2"
				>
					<div className="mr-auto min-w-0">
						<div className="text-xs font-semibold text-amber-200">
							Paused before {pausedPayload?.stepId ?? "next step"}
						</div>
						<details className="text-[10px] text-zinc-400">
							<summary className="cursor-pointer hover:text-zinc-200">Resolved inputs</summary>
							<pre className="mt-1 max-h-32 max-w-xl overflow-auto rounded bg-zinc-950/70 p-2 font-mono text-zinc-300">
								{JSON.stringify(pausedPayload?.inputs ?? {}, null, 2)}
							</pre>
						</details>
					</div>
					<DebugButton
						label="Continue"
						shortcut="F8"
						icon={Play}
						disabled={controlPending}
						onClick={() => void sendControl("continue")}
					/>
					<DebugButton
						label="Step"
						shortcut="F10"
						icon={SkipForward}
						disabled={controlPending}
						onClick={() => void sendControl("step")}
					/>
					<DebugButton
						label="Stop"
						shortcut="⇧F5"
						icon={Square}
						disabled={controlPending}
						onClick={() => void sendControl("stop")}
						danger
					/>
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
						onNodeClick={(_event, node) => selectCanvasNode(node)}
						onNodeDoubleClick={(_event, node) => toggleBreakpoint(node)}
						onNodeDragStop={(_event, node) => {
							if (editing && flowNodeStepId(node)) setDirty(true);
						}}
						nodeTypes={nodeTypes}
						fitView
						fitViewOptions={{ padding: 0.25 }}
						proOptions={{ hideAttribution: true }}
						minZoom={0.1}
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
						selectedArtifact={selectedArtifact}
						onShowLive={() => setSelectedArtifact(undefined)}
						className="h-[600px] min-w-0 border-l border-zinc-800"
					/>
				)}
			</div>
			{runQuery.data && (
				<ActivityDrawer
					nodes={runQuery.data.nodes}
					logs={runQuery.data.logs}
					stepUses={stepUses}
					selectedNodeId={selectedNodeId}
					selectedArtifactId={selectedArtifact?.id}
					onSelectNode={setSelectedNodeId}
					onSelectArtifact={(artifact, nodeId) => {
						setSelectedNodeId(nodeId);
						setSelectedArtifact(artifact);
						if (runQuery.data.browserSession) setWorkspaceMode("split");
					}}
				/>
			)}
		</div>
	);
}

function DebugButton({
	label,
	shortcut,
	icon: Icon,
	disabled,
	onClick,
	danger = false,
}: {
	label: string;
	shortcut: string;
	icon: IconComponent;
	disabled: boolean;
	onClick: () => void;
	danger?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:opacity-40",
				danger
					? "border-red-400/30 text-red-200 hover:bg-red-400/10"
					: "border-zinc-600 bg-zinc-900/80 text-zinc-200 hover:bg-zinc-800",
			)}
		>
			<Icon className="h-3.5 w-3.5" />
			{label}
			<kbd className="rounded border border-zinc-700 px-1 font-mono text-[9px] text-zinc-500">{shortcut}</kbd>
		</button>
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
	// Step cards carry config rows; control-flow cards are header + condition.
	if (kind === "regular" || kind === "subworkflow" || kind === "wait") {
		return { width: NODE_WIDTH, height: NODE_HEIGHT };
	}
	return { width: NODE_WIDTH, height: FLOW_NODE_HEIGHT };
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
	g.setGraph({ rankdir: config?.canvas?.direction ?? "TB", nodesep: 48, ranksep: 72, acyclicer: "greedy" });

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
		// Back-edges (forEach/loop returns) must not influence ranking, and
		// dagre 0.8.5 NaNs the x-coordinate pass when an edge has weight 0 —
		// so keep them out of the layout graph entirely. They still render:
		// flowEdges below is built from dag.edges, not from g.
		if (e.backEdge) continue;
		g.setEdge(e.source, e.target, { weight: 1 });
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
			stroke: edge.backEdge ? "#a78bfa" : "#52525b",
			strokeWidth: 1.5,
			strokeDasharray: dashed ? "4 4" : undefined,
		},
		markerEnd: {
			type: MarkerType.ArrowClosed,
			width: 14,
			height: 14,
			color: edge.backEdge ? "#a78bfa" : "#52525b",
		},
		type: edge.backEdge ? "default" : "smoothstep",
	};
}

// === Node renderers ===

// Lucide accepts a generic SVG icon component. Type the renderer prop
// loosely (LucideIcon) and cap consumers to the icons we import above.
type IconComponent = typeof Play;

/** One key/value config row on a node card (the BuildShip-style summary). */
interface ConfigRow {
	label: string;
	value: string;
	kind: "text" | "fx" | "obj";
}

const MAX_CONFIG_ROWS = 3;

/**
 * Summarize a step's raw `inputs` into card rows: `js/` expressions render
 * as ƒx chips, objects/arrays as {} chips, primitives verbatim. Purely
 * presentational — the inspector remains the write path.
 */
function configRows(raw: unknown): ConfigRow[] {
	if (typeof raw !== "object" || raw === null) return [];
	const inputs = (raw as { inputs?: unknown }).inputs;
	if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) return [];
	return Object.entries(inputs as Record<string, unknown>)
		.slice(0, MAX_CONFIG_ROWS)
		.map(([label, value]) => {
			if (typeof value === "string") {
				return value.startsWith("js/")
					? { label, value: value.slice(3), kind: "fx" as const }
					: { label, value, kind: "text" as const };
			}
			if (typeof value === "object" && value !== null) {
				return { label, value: JSON.stringify(value), kind: "obj" as const };
			}
			return { label, value: String(value), kind: "text" as const };
		});
}

interface NodeShellProps {
	icon: IconComponent;
	iconClass: string;
	/** Tailwind bg for the header icon tile, e.g. "bg-emerald-500/15". */
	iconTile: string;
	title: string;
	subtitle?: string;
	accent: string;
	status?: NodeRunStatus;
	/** Dashed border — control-flow cards, matching the BuildShip design. */
	dashed?: boolean;
	rows?: ConfigRow[];
	selected?: boolean;
}

function NodeShell({
	icon: Icon,
	iconClass,
	iconTile,
	title,
	subtitle,
	accent,
	status,
	dashed,
	rows,
	selected,
}: NodeShellProps) {
	const hasBody = Boolean(subtitle) || (rows?.length ?? 0) > 0;
	return (
		<div
			className={cn(
				"w-[260px] rounded-xl border bg-[#151518] shadow-lg shadow-black/30 transition-colors hover:border-zinc-500",
				accent,
				dashed && "border-dashed",
				// ATOMIC's single-accent selection: a 2px inset blue outline.
				selected && "outline outline-2 -outline-offset-2 outline-blue-400",
				status === "running" && "border-blue-400 shadow-[0_0_0_1px_#60a5fa,0_0_24px_rgba(96,165,250,0.25)]",
				status === "completed" && "border-emerald-500/60",
				status === "failed" && "border-red-500/70",
				status === "skipped" && "opacity-50",
			)}
		>
			<div className={cn("flex items-center gap-2 px-3 py-2", hasBody && "border-b border-zinc-800/70")}>
				<span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", iconTile)}>
					<Icon className={cn("h-3.5 w-3.5", iconClass)} />
				</span>
				<span className="truncate text-xs font-semibold text-zinc-100">{title}</span>
				{status === "running" && <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-blue-400" />}
				{status === "completed" && <CheckCircle2 className="ml-auto h-3 w-3 shrink-0 text-emerald-400" />}
				{status === "failed" && <AlertTriangle className="ml-auto h-3 w-3 shrink-0 text-red-400" />}
				{(status === "skipped" || status === "pending") && (
					<span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-zinc-500" title={status} />
				)}
			</div>
			{hasBody && (
				<div className="space-y-1 px-3 py-2">
					{subtitle && <div className="truncate font-mono text-[10px] text-zinc-500">{subtitle}</div>}
					{rows?.map((row) => (
						<div key={row.label} className="flex items-center gap-2">
							<span className="w-20 shrink-0 truncate text-[10px] text-zinc-400">{row.label}</span>
							<span className="min-w-0 flex-1 truncate rounded-md bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
								{row.kind === "fx" && <span className="mr-1 text-blue-300">ƒx</span>}
								{row.kind === "obj" && <span className="mr-1 text-violet-300">{"{}"}</span>}
								{row.value}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

const PORT_CLASS =
	"w-2.5! h-2.5! rounded-full! bg-zinc-950! border-2! border-zinc-500! transition-colors hover:border-blue-400!";

function withHandles(content: React.ReactNode) {
	return (
		<>
			<Handle type="target" position={Position.Top} className={PORT_CLASS} />
			{content}
			<Handle type="source" position={Position.Bottom} className={PORT_CLASS} />
		</>
	);
}

function asData(props: NodeProps): LiveDagNodeData {
	return props.data as unknown as LiveDagNodeData;
}

function TriggerNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<div className="min-w-[130px] rounded-full border border-emerald-500/50 bg-[#151518] px-4 py-1.5 text-center shadow-lg shadow-emerald-500/10">
			<div className="flex items-center justify-center gap-1.5">
				<span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/20">
					<Play className="h-2.5 w-2.5 text-emerald-400" />
				</span>
				<span className="truncate text-[11px] font-semibold text-emerald-200">{data.label}</span>
			</div>
			{data.sublabel && (
				<div className="mt-0.5 truncate font-mono text-[10px] text-emerald-400/70">{data.sublabel}</div>
			)}
		</div>,
	);
}

function EndNode(props: NodeProps) {
	const data = asData(props);
	return (
		<>
			<Handle type="target" position={Position.Top} className="bg-zinc-600! w-2! h-2! border-0!" />
			<div className="min-w-[90px] rounded-full border border-zinc-700 bg-[#151518] px-4 py-1.5 text-center shadow-lg shadow-black/30">
				<div className="flex items-center justify-center gap-1.5">
					<CheckCircle2 className="h-3 w-3 text-zinc-400" />
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
			iconClass="text-zinc-300"
			iconTile="bg-zinc-700/60"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-zinc-800"
			status={data.liveStatus}
			selected={props.selected}
			rows={configRows(data.meta?.raw)}
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
			iconClass="text-indigo-300"
			iconTile="bg-indigo-500/15"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-indigo-500/40"
			status={data.liveStatus}
			selected={props.selected}
			rows={configRows(data.meta?.raw)}
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
			iconTile="bg-amber-500/15"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-amber-500/40"
			status={data.liveStatus}
			selected={props.selected}
			rows={configRows(data.meta?.raw)}
		/>,
	);
}

function DecisionNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={GitBranch}
			iconClass="text-yellow-300"
			iconTile="bg-yellow-500/15"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-yellow-500/50"
			status={data.liveStatus}
			selected={props.selected}
			dashed
		/>,
	);
}

function SwitchNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Split}
			iconClass="text-orange-300"
			iconTile="bg-orange-500/15"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-orange-500/50"
			status={data.liveStatus}
			selected={props.selected}
			dashed
		/>,
	);
}

function IterationNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Repeat}
			iconClass="text-violet-300"
			iconTile="bg-violet-500/15"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-violet-500/50"
			status={data.liveStatus}
			selected={props.selected}
			dashed
		/>,
	);
}

function LoopNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={RotateCw}
			iconClass="text-violet-300"
			iconTile="bg-violet-500/15"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-violet-500/50"
			status={data.liveStatus}
			selected={props.selected}
			dashed
		/>,
	);
}

function TryNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Shield}
			iconClass="text-red-300"
			iconTile="bg-red-500/15"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-red-500/40"
			status={data.liveStatus}
			selected={props.selected}
			dashed
		/>,
	);
}

function CatchNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={ShieldX}
			iconClass="text-red-400"
			iconTile="bg-red-500/15"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-red-500/60"
			status={data.liveStatus}
			selected={props.selected}
			dashed
		/>,
	);
}

function FinallyNode(props: NodeProps) {
	const data = asData(props);
	return withHandles(
		<NodeShell
			icon={Shield}
			iconClass="text-orange-300"
			iconTile="bg-orange-500/15"
			title={data.label}
			subtitle={data.sublabel}
			accent="border-orange-500/40"
			status={data.liveStatus}
			selected={props.selected}
			dashed
		/>,
	);
}

function MergeNode(_props: NodeProps) {
	return (
		<>
			<Handle type="target" position={Position.Top} className="bg-zinc-600! w-1.5! h-1.5! border-0!" />
			<div className="h-3 w-3 rounded-full border-2 border-zinc-500 bg-zinc-950" />
			<Handle type="source" position={Position.Bottom} className="bg-zinc-600! w-1.5! h-1.5! border-0!" />
		</>
	);
}
