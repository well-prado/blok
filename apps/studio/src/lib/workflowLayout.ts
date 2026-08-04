import type { WorkflowStudioConfig } from "@/types";

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
	return workflowNodePosition(sidecar) ?? workflowNodePosition(inlineUi) ?? autoLayout;
}

export function workflowNodePosition(value: unknown): WorkflowNodePosition | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { x, y } = value as { x?: unknown; y?: unknown };
	if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
		return undefined;
	}
	return { x, y };
}

export function withWorkflowNodePositions(
	config: WorkflowStudioConfig | null,
	workflow: string,
	positions: Iterable<{ stepId?: string; position: WorkflowNodePosition }>,
): WorkflowStudioConfig {
	const nodes = { ...(config?.nodes ?? {}) };
	for (const { stepId, position } of positions) {
		if (!stepId) continue;
		nodes[stepId] = {
			...nodes[stepId],
			x: Math.round(position.x),
			y: Math.round(position.y),
		};
	}
	return {
		...config,
		schemaVersion: 1,
		workflow,
		canvas: config?.canvas ?? { direction: "TB" },
		nodes,
	};
}
