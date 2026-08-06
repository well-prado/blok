import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for "clicking a node jumps the camera to the trigger": the
 * canvas must fit the viewport exactly once per workflow (imperatively,
 * guarded by a ref — see the `firstFitRef` effect in WorkflowGraph.tsx),
 * never as a side effect of opening/closing the step drawer or toggling
 * full screen. This mock stands in for `@xyflow/react` (real xyflow can't
 * run its layout/measurement pipeline in jsdom — no ResizeObserver — so
 * fitView never actually resolves there; see WorkflowGraph.editor.test.tsx
 * for the same constraint) and exposes a spy `fitView` via the `onInit`
 * callback, mirroring xyflow's real "call onInit once per mount" contract.
 */
const mocks = vi.hoisted(() => ({
	fitView: vi.fn(),
}));

vi.mock("@/hooks/useRunDetail", () => ({
	useRunDetail: () => ({ data: undefined }),
	useTraceStream: () => undefined,
}));

vi.mock("@/hooks/useWorkflows", () => ({
	useWorkflowStudio: () => ({
		data: {
			schemaVersion: 1 as const,
			workflow: "checkout",
			nodes: {},
			sourcePath: "/project/checkout.json",
			writable: true,
		},
		isLoading: false,
		error: null,
		refetch: vi.fn(),
	}),
	useSaveWorkflowStudio: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
	useEditWorkflowDefinition: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
	useNodeCatalog: () => ({ data: { nodes: [], count: 0 }, isLoading: false, error: null }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return { ...actual, startTestRun: vi.fn(), controlDebugRun: vi.fn() };
});

vi.mock("@xyflow/react", async () => {
	const ReactModule = await import("react");
	return {
		Background: () => null,
		Controls: () => null,
		Handle: () => null,
		MarkerType: { ArrowClosed: "arrowclosed" },
		Position: { Top: "top", Bottom: "bottom" },
		ReactFlow: ({
			children,
			nodes,
			onInit,
			onNodeClick,
			onNodesChange,
		}: {
			children: React.ReactNode;
			nodes: Array<{ id: string; data: { meta?: { stepId?: string } } }>;
			onInit?: (instance: unknown) => void;
			onNodeClick?: (event: React.MouseEvent, node: unknown) => void;
			onNodesChange?: (changes: Array<{ id: string; type: "select"; selected: boolean }>) => void;
		}) => {
			// Real xyflow calls `onInit` exactly once per mount (guarded
			// internally by a ref) — mirror that so a genuine remount is the
			// only thing that could call it twice.
			ReactModule.useEffect(() => {
				onInit?.({
					fitView: mocks.fitView,
					getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
					screenToFlowPosition: (point: unknown) => point,
				});
			}, []);
			return (
				<div data-testid="workflow-canvas">
					{nodes.flatMap((node) =>
						node.data.meta?.stepId ? (
							<button
								type="button"
								key={node.id}
								aria-label={`Canvas node ${node.data.meta.stepId}`}
								onClick={(event) => {
									onNodesChange?.([{ id: node.id, type: "select", selected: true }]);
									onNodeClick?.(event, node);
								}}
							/>
						) : (
							[]
						),
					)}
					{children}
				</div>
			);
		},
		useNodesState: <T extends { id: string }>(initial: T[]) => {
			const [nodes, setNodes] = ReactModule.useState(initial);
			const onNodesChange = (changes: Array<{ id: string; type: string; selected?: boolean }>) =>
				setNodes((current) =>
					current.map((node) => {
						const change = changes.find((c) => c.type === "select" && c.id === node.id);
						return change ? { ...node, selected: change.selected } : node;
					}),
				);
			return [nodes, setNodes, onNodesChange] as const;
		},
	};
});

import { WorkflowGraph } from "./WorkflowGraph";

const definition = {
	trigger: { http: { method: "POST", path: "/checkout" } },
	steps: [
		{ id: "open", use: "@blokjs/browser-open" },
		{ id: "assert", use: "@blokjs/browser-assert" },
	],
};

describe("WorkflowGraph — camera does not jump on node click", () => {
	beforeEach(() => {
		mocks.fitView.mockClear();
	});

	it("fits once on mount and stays put through node click, drawer close, and full screen", async () => {
		const user = userEvent.setup();
		render(<WorkflowGraph definition={definition} workflowName="checkout" />);

		await waitFor(() => expect(mocks.fitView).toHaveBeenCalledTimes(1));

		// Clicking a step node opens its config drawer (ION/ATOMIC pattern).
		await user.click(screen.getByRole("button", { name: "Canvas node open" }));
		expect(screen.getByRole("form", { name: "Inputs for open" })).toBeInTheDocument();
		expect(mocks.fitView).toHaveBeenCalledTimes(1);

		// Closing the drawer must not re-fit either.
		await user.keyboard("{Escape}");
		expect(mocks.fitView).toHaveBeenCalledTimes(1);

		// Toggling full screen changes the wrapper's layout classes, not the
		// canvas's position in the tree — must not remount/re-fit.
		await user.click(screen.getByRole("button", { name: /^full screen$/i }));
		expect(mocks.fitView).toHaveBeenCalledTimes(1);
		await user.click(screen.getByRole("button", { name: /exit full screen/i }));
		expect(mocks.fitView).toHaveBeenCalledTimes(1);

		// The explicit "Fit workflow" toolbar button must still work.
		await user.click(screen.getByRole("button", { name: /fit workflow/i }));
		expect(mocks.fitView).toHaveBeenCalledTimes(2);
	});
});
