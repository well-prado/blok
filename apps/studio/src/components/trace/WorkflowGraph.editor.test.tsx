import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	mutate: vi.fn(),
	refetch: vi.fn(),
	reset: vi.fn(),
	runData: undefined as undefined | Record<string, unknown>,
	startTestRun: vi.fn(),
	controlDebugRun: vi.fn(),
	studioData: {
		config: { schemaVersion: 1 as const, workflow: "checkout", nodes: { open: { x: 10, y: 20 } } },
		sourcePath: "/project/checkout.ts",
		writable: true,
		etag: "v1",
	},
}));

vi.mock("@/hooks/useRunDetail", () => ({
	useRunDetail: () => ({ data: mocks.runData }),
	useTraceStream: () => undefined,
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return { ...actual, startTestRun: mocks.startTestRun, controlDebugRun: mocks.controlDebugRun };
});

vi.mock("@/hooks/useWorkflows", () => ({
	useWorkflowStudio: () => ({
		data: mocks.studioData,
		isLoading: false,
		error: null,
		refetch: mocks.refetch,
	}),
	useSaveWorkflowStudio: () => ({
		mutate: mocks.mutate,
		reset: mocks.reset,
		isPending: false,
		error: null,
	}),
}));

vi.mock("@xyflow/react", async () => {
	const ReactModule = await import("react");
	return {
		Background: () => null,
		Controls: () => null,
		Handle: () => null,
		MiniMap: () => null,
		Position: { Top: "top", Bottom: "bottom" },
		ReactFlow: ({
			children,
			nodes,
			onNodeDoubleClick,
		}: {
			children: React.ReactNode;
			nodes: Array<{ id: string; data: { meta?: { stepId?: string } } }>;
			onNodeDoubleClick?: (event: React.MouseEvent, node: unknown) => void;
		}) => (
			<div data-testid="workflow-canvas">
				{nodes.flatMap((node) =>
					node.data.meta?.stepId ? (
						<button
							type="button"
							key={node.id}
							aria-label={`Canvas node ${node.data.meta.stepId}`}
							onDoubleClick={(event) => onNodeDoubleClick?.(event, node)}
						/>
					) : (
						[]
					),
				)}
				{children}
			</div>
		),
		useNodesState: <T,>(initial: T[]) => {
			const [nodes, setNodes] = ReactModule.useState(initial);
			return [nodes, setNodes, () => {}] as const;
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

describe("WorkflowGraph layout editor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.runData = undefined;
		mocks.startTestRun.mockResolvedValue({ runId: "run-123", stream: "/runs/run-123/stream" });
		mocks.controlDebugRun.mockResolvedValue({ runId: "run-123", action: "step", status: "running" });
	});

	it("switches between canvas, split, and browser focus modes", async () => {
		mocks.runData = {
			run: { status: "completed" },
			nodes: [],
			logs: [],
			browserSession: {
				sessionId: "session-1",
				pageId: "page-1",
				stream: "/stream",
				status: "closed",
				autoOpen: true,
			},
			browserEvents: [],
		};
		const user = userEvent.setup();
		render(<WorkflowGraph definition={definition} workflowName="checkout" />);

		expect(screen.getByRole("region", { name: "Live browser" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^canvas$/i }));
		expect(screen.queryByRole("region", { name: "Live browser" })).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /browser/i }));
		expect(screen.getByRole("region", { name: "Live browser" })).toBeInTheDocument();
	});

	it("starts a workflow run from the canvas", async () => {
		const user = userEvent.setup();
		render(<WorkflowGraph definition={definition} workflowName="checkout" />);

		await user.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mocks.startTestRun).toHaveBeenCalledWith("checkout");
	});

	it("starts debug mode with transient canvas breakpoints", async () => {
		const user = userEvent.setup();
		render(<WorkflowGraph definition={definition} workflowName="checkout" />);

		await user.selectOptions(screen.getByRole("combobox", { name: "Run mode" }), "debug");
		await user.dblClick(screen.getByRole("button", { name: "Canvas node open" }));
		expect(screen.getByText(/1 set/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^debug$/i }));

		expect(mocks.startTestRun).toHaveBeenCalledWith("checkout", {
			mode: "debug",
			breakpoints: ["open"],
		});
	});

	it("shows paused inputs and sends Step from the debug toolbar", async () => {
		mocks.runData = {
			run: { id: "run-123", status: "paused" },
			nodes: [],
			logs: [],
			events: [
				{
					id: "event-1",
					type: "RUN_PAUSED",
					payload: { stepId: "open", inputs: { url: "https://example.com" } },
				},
			],
		};
		const user = userEvent.setup();
		render(<WorkflowGraph definition={definition} workflowName="checkout" />);
		await user.click(screen.getByText("Resolved inputs"));
		expect(screen.getByText(/example\.com/)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /stepf10/i }));

		expect(mocks.controlDebugRun).toHaveBeenCalledWith("run-123", "step");
	});

	it("keeps dragging actions behind an explicit edit mode and supports discard", async () => {
		const user = userEvent.setup();
		render(<WorkflowGraph definition={definition} workflowName="checkout" />);

		await user.click(screen.getByRole("button", { name: /edit layout/i }));
		expect(screen.getByRole("button", { name: /auto layout/i })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /auto layout/i }));
		expect(screen.getByText(/unsaved/i)).toBeInTheDocument();

		const unload = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(unload);
		expect(unload.defaultPrevented).toBe(true);

		await user.click(screen.getByRole("button", { name: /discard/i }));
		expect(screen.getByRole("button", { name: /edit layout/i })).toBeInTheDocument();
		expect(screen.queryByText(/unsaved/i)).not.toBeInTheDocument();
	});

	it("saves all real step positions against the loaded etag", async () => {
		const user = userEvent.setup();
		render(<WorkflowGraph definition={definition} workflowName="checkout" />);
		await user.click(screen.getByRole("button", { name: /edit layout/i }));
		await user.click(screen.getByRole("button", { name: /auto layout/i }));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(mocks.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				baseEtag: "v1",
				config: expect.objectContaining({
					workflow: "checkout",
					nodes: expect.objectContaining({ open: expect.any(Object), assert: expect.any(Object) }),
				}),
			}),
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		);
	});
});
