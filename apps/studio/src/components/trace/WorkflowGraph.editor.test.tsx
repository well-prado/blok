import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	mutate: vi.fn(),
	refetch: vi.fn(),
	reset: vi.fn(),
	startTestRun: vi.fn(),
	studioData: {
		config: { schemaVersion: 1 as const, workflow: "checkout", nodes: { open: { x: 10, y: 20 } } },
		sourcePath: "/project/checkout.ts",
		writable: true,
		etag: "v1",
	},
}));

vi.mock("@/hooks/useRunDetail", () => ({
	useRunDetail: () => ({ data: undefined }),
	useTraceStream: () => undefined,
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return { ...actual, startTestRun: mocks.startTestRun };
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
		ReactFlow: ({ children }: { children: React.ReactNode }) => <div data-testid="workflow-canvas">{children}</div>,
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
		mocks.startTestRun.mockResolvedValue({ runId: "run-123", stream: "/runs/run-123/stream" });
	});

	it("starts a workflow run from the canvas", async () => {
		const user = userEvent.setup();
		render(<WorkflowGraph definition={definition} workflowName="checkout" />);

		await user.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mocks.startTestRun).toHaveBeenCalledWith("checkout");
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
