import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for "full screen is a persisted choice, not per-mount state"
 * (founder request: expanding the canvas should stick across reloads and
 * across workflows). Reuses the cheap xyflow mock from
 * WorkflowGraph.fitView.test.tsx — real xyflow can't run its
 * layout/measurement pipeline in jsdom (no ResizeObserver).
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
	useEditWorkflowDefinition: () => ({
		mutate: vi.fn(),
		reset: vi.fn(),
		isPending: false,
		error: null,
		hasDraft: false,
		validation: { status: "idle" },
		discard: vi.fn(),
		deploy: vi.fn(),
		deploying: false,
		justDeployed: false,
	}),
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
			onInit,
		}: {
			children: React.ReactNode;
			nodes: Array<{ id: string; data: { meta?: { stepId?: string } } }>;
			onInit?: (instance: unknown) => void;
		}) => {
			ReactModule.useEffect(() => {
				onInit?.({
					fitView: mocks.fitView,
					getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
					screenToFlowPosition: (point: unknown) => point,
				});
			}, []);
			return <div data-testid="workflow-canvas">{children}</div>;
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
	steps: [{ id: "open", use: "@blokjs/browser-open" }],
};

const STORAGE_KEY = "blok-studio.canvas.fullscreen";

describe("WorkflowGraph — full screen persists as a user preference", () => {
	beforeEach(() => {
		mocks.fitView.mockClear();
		localStorage.clear();
	});

	it("opens already expanded when a prior session persisted the choice", () => {
		localStorage.setItem(STORAGE_KEY, "1");
		const { container } = render(<WorkflowGraph definition={definition} workflowName="checkout" />);

		expect(screen.getByRole("button", { name: /exit full screen/i })).toBeInTheDocument();
		expect(container.firstElementChild).toHaveClass("fixed");
	});

	it("defaults to the compact canvas when nothing was ever persisted", () => {
		const { container } = render(<WorkflowGraph definition={definition} workflowName="checkout" />);

		expect(screen.getByRole("button", { name: /^full screen$/i })).toBeInTheDocument();
		expect(container.firstElementChild).not.toHaveClass("fixed");
	});

	it("persists '1' on expand and '0' on collapse, via the same toggle button", async () => {
		const user = userEvent.setup();
		render(<WorkflowGraph definition={definition} workflowName="checkout" />);

		await user.click(screen.getByRole("button", { name: /^full screen$/i }));
		expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
		expect(screen.getByRole("button", { name: /exit full screen/i })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /exit full screen/i }));
		expect(localStorage.getItem(STORAGE_KEY)).toBe("0");
		expect(screen.getByRole("button", { name: /^full screen$/i })).toBeInTheDocument();
	});
});
