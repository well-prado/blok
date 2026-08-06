import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from "@xyflow/react";
import { Plus } from "lucide-react";
import { createContext, useContext, useState } from "react";

/**
 * atomic-canvas's signature edge: a permanent midpoint dot that swaps to a
 * "+" button on hover, splicing a palette-picked node into the connection
 * (their Edges/Default). The whole <g> is the hover target so the swap
 * feels generous; hover also turns the stroke blue, matching the selection
 * accent. Splicing is only offered when `data.spliceTargetStepId` is set —
 * the edge's target step pins the insert position via insertStepBefore.
 */

/** Set by WorkflowGraph when the definition is editable; null disables "+". */
export const SpliceContext = createContext<((targetStepId: string) => void) | null>(null);

export function SpliceEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	markerEnd,
	style,
	data,
	selected,
}: EdgeProps) {
	const onSplice = useContext(SpliceContext);
	const [hovered, setHovered] = useState(false);
	const [edgePath, labelX, labelY] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
		borderRadius: 24,
	});
	const spliceTargetStepId = (data as { spliceTargetStepId?: string } | undefined)?.spliceTargetStepId;
	const splicable = Boolean(onSplice && spliceTargetStepId);
	const active = hovered || selected;

	return (
		<g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd={markerEnd}
				style={{ ...style, ...(active ? { stroke: "#60a5fa" } : {}) }}
			/>
			{/* Wide invisible hit area so the midpoint is easy to reach. */}
			<path d={edgePath} fill="none" stroke="transparent" strokeWidth={16} />
			{splicable && (
				<EdgeLabelRenderer>
					<div
						style={{
							position: "absolute",
							transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
							pointerEvents: "all",
						}}
						className="nodrag nopan"
						onMouseEnter={() => setHovered(true)}
						onMouseLeave={() => setHovered(false)}
					>
						{hovered ? (
							<button
								type="button"
								title="Add a node here"
								aria-label={`Insert a node before ${spliceTargetStepId}`}
								// biome-ignore lint/style/noNonNullAssertion: splicable guarantees both
								onClick={() => onSplice!(spliceTargetStepId!)}
								className="flex h-5 w-5 items-center justify-center rounded-full border border-blue-400/60 bg-[#111113] text-blue-300 shadow-lg transition-colors hover:bg-blue-500/20"
							>
								<Plus className="h-3 w-3" />
							</button>
						) : (
							<div className="h-2 w-2 rounded-full border border-zinc-500 bg-[#111113]" />
						)}
					</div>
				</EdgeLabelRenderer>
			)}
		</g>
	);
}
