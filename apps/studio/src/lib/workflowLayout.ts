export interface WorkflowNodePosition {
	x: number;
	y: number;
}

/** Resolve one node using the committed sidecar, legacy inline UI, then dagre. */
export function resolveWorkflowNodePosition(
	sidecar: unknown,
	inlineUi: unknown,
	autoLayout: WorkflowNodePosition,
): WorkflowNodePosition {
	return finitePosition(sidecar) ?? finitePosition(inlineUi) ?? autoLayout;
}

function finitePosition(value: unknown): WorkflowNodePosition | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { x, y } = value as { x?: unknown; y?: unknown };
	if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
		return undefined;
	}
	return { x, y };
}
