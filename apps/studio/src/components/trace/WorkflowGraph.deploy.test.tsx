import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * feat/studio-deploy-ux — component-level coverage for the Deploy guard.
 * Unlike WorkflowGraph.editor.test.tsx (which mocks `useEditWorkflowDefinition`
 * wholesale to inspect the transform functions), this file lets the REAL
 * hook run so the debounced dry-run validation + Deploy button disabled/
 * enabled/stale states are exercised end to end. Only the network layer
 * (`@/lib/api`) and the xyflow canvas are mocked — same mock harness
 * pattern as WorkflowGraph.fitView.test.tsx / editor.test.tsx.
 */
const mocks = vi.hoisted(() => ({
	fetchWorkflowDefinition: vi.fn(),
	saveWorkflowDefinition: vi.fn(),
	dryRunWorkflowDefinition: vi.fn(),
	startTestRun: vi.fn(),
	controlDebugRun: vi.fn(),
}));

vi.mock("@/hooks/useRunDetail", () => ({
	useRunDetail: () => ({ data: undefined }),
	useTraceStream: () => undefined,
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		fetchWorkflowDefinition: mocks.fetchWorkflowDefinition,
		saveWorkflowDefinition: mocks.saveWorkflowDefinition,
		dryRunWorkflowDefinition: mocks.dryRunWorkflowDefinition,
		startTestRun: mocks.startTestRun,
		controlDebugRun: mocks.controlDebugRun,
	};
});

// Only the layout/catalog hooks are stubbed — useEditWorkflowDefinition
// stays real so it actually drives the draft + deploy guard.
vi.mock("@/hooks/useWorkflows", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks/useWorkflows")>();
	return {
		...actual,
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
		useNodeCatalog: () => ({ data: { nodes: [], count: 0 }, isLoading: false, error: null }),
	};
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
			onNodeClick,
			onNodesChange,
		}: {
			children: React.ReactNode;
			nodes: Array<{ id: string; data: { meta?: { stepId?: string } } }>;
			onNodeClick?: (event: React.MouseEvent, node: unknown) => void;
			onNodesChange?: (changes: Array<{ id: string; type: "select"; selected: boolean }>) => void;
		}) => (
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
		),
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
	name: "checkout",
	trigger: { http: { method: "POST", path: "/checkout" } },
	steps: [
		{ id: "open", use: "@blokjs/browser-open", type: "module", inputs: {} },
		{ id: "assert", use: "@blokjs/browser-assert", type: "module", inputs: {} },
	],
};

function renderGraph() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<WorkflowGraph definition={definition} workflowName="checkout" />
		</QueryClientProvider>,
	);
}

/** Rename "open" → "opened": the shortest path through the real hook to a draft. */
async function createDraft(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "Canvas node open" }));
	await user.click(screen.getByRole("button", { name: /rename/i }));
	const input = screen.getByLabelText(/rename/i);
	await user.clear(input);
	await user.type(input, "opened");
	await user.click(screen.getByRole("button", { name: /^save$/i }));
}

describe("WorkflowGraph — Deploy guard (feat/studio-deploy-ux)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition,
			etag: "etag-1",
			sourcePath: "/project/checkout.json",
		});
		mocks.startTestRun.mockResolvedValue({ runId: "run-123", stream: "/runs/run-123/stream" });
	});

	it("shows Deploy disabled (not hidden) until a draft exists — BuildShip bar never jumps", () => {
		renderGraph();
		const deployButton = screen.getByRole("button", { name: /^deploy$/i });
		expect(deployButton).toBeDisabled();
		expect(deployButton).toHaveAttribute("title", "No undeployed changes");
	});

	it("renders Run as a ghost control attached to the run-mode select in one group", () => {
		renderGraph();
		const runButton = screen.getByRole("button", { name: /^run$/i });
		expect(runButton).toHaveClass("run-ghost-button");
		const group = screen.getByTestId("run-control-group");
		expect(group).toContainElement(runButton);
		expect(group).toContainElement(screen.getByLabelText("Run mode"));
	});

	it("disables Deploy while the dry run is pending, then enables it once valid", async () => {
		// #744: the old version let `dryRunWorkflowDefinition` resolve
		// immediately and bet that the assertion below would run inside the
		// 500ms debounce window. Under load (or just a slow tick) the debounce
		// timer + instant-resolving mock can both fire before the assertion
		// runs, so the button is already enabled — a race asserted with timing.
		// Hold the dry run open explicitly instead: Deploy can only leave
		// "pending" once THIS test lets it, so the disabled check is a state
		// handshake, not a bet on scheduling.
		let resolveDryRun!: (value: { valid: true; etag: string }) => void;
		mocks.dryRunWorkflowDefinition.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveDryRun = resolve;
				}),
		);
		const user = userEvent.setup();
		renderGraph();

		await createDraft(user);

		const deployButton = await screen.findByRole("button", { name: /^deploy$/i });
		await waitFor(() => expect(mocks.dryRunWorkflowDefinition).toHaveBeenCalled(), { timeout: 2000 });
		expect(deployButton).toBeDisabled();

		resolveDryRun({ valid: true, etag: "etag-1" });
		await waitFor(() => expect(deployButton).toBeEnabled(), { timeout: 2000 });
	});

	it("an invalid dry run disables Deploy and surfaces the server's error message", async () => {
		mocks.dryRunWorkflowDefinition.mockRejectedValue(new Error('duplicate id "opened"'));
		const user = userEvent.setup();
		renderGraph();

		await createDraft(user);

		await waitFor(() => expect(screen.getByText('duplicate id "opened"')).toBeInTheDocument(), { timeout: 2000 });
		expect(screen.getByRole("button", { name: /^deploy$/i })).toBeDisabled();
	});

	it("a stale_etag (409) dry run shows the reload affordance instead of an invalid message", async () => {
		const { ApiError } = await import("@/lib/api");
		mocks.dryRunWorkflowDefinition.mockRejectedValue(
			new ApiError(409, "Workflow definition changed since it was loaded."),
		);
		const user = userEvent.setup();
		renderGraph();

		await createDraft(user);

		const reloadButton = await screen.findByRole("button", { name: /discard.*reload/i }, { timeout: 2000 });
		expect(reloadButton).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^deploy$/i })).toBeDisabled();

		// Clicking it drops the draft — Deploy stays visible but goes back to disabled.
		await user.click(reloadButton);
		await waitFor(() => expect(screen.getByRole("button", { name: /^deploy$/i })).toBeDisabled());
	});

	it("does not block Run when a draft exists, but hints it runs the deployed version", async () => {
		mocks.dryRunWorkflowDefinition.mockResolvedValue({ valid: true, etag: "etag-1" });
		const user = userEvent.setup();
		renderGraph();

		await createDraft(user);

		const runButton = screen.getByRole("button", { name: /^run$/i });
		expect(runButton).toBeEnabled();
		expect(runButton).toHaveAttribute("title", expect.stringMatching(/deployed version/i));

		await user.click(runButton);
		expect(mocks.startTestRun).toHaveBeenCalledWith("checkout");
	});
});
