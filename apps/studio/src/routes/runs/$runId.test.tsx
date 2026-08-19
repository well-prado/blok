import { ShortcutProvider } from "@/components/providers/ShortcutProvider";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./$runId";

const RunTracePage = Route.options.component as React.FC;

const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<unknown>();
	return {
		...(actual as Record<string, unknown>),
		useNavigate: () => mockNavigate,
		Link: ({
			children,
			to,
			params,
			...props
		}: { children: React.ReactNode; to: string; params?: { runId?: string; name?: string } }) => (
			<a href={to} data-testid={`link-${params?.runId || params?.name}`} {...props}>
				{children}
			</a>
		),
	};
});

vi.mock("@/hooks/useRunDetail", () => ({
	useRunDetail: vi.fn(),
	useSubRuns: () => ({ data: [] }),
	useTraceStream: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: vi.fn(),
	useMutation: vi.fn(() => ({ mutate: vi.fn() })),
	useQueryClient: vi.fn(() => ({
		setQueryData: vi.fn(),
		invalidateQueries: vi.fn(),
	})),
}));

vi.mock("@/lib/api", () => ({
	exportRunCsv: vi.fn(),
	exportRunJson: vi.fn(),
	replayRun: vi.fn(),
	fetchRuns: vi.fn(),
}));

import { useRunDetail } from "@/hooks/useRunDetail";

// We need to mock useParams for the Route somehow, but Route.useParams is attached by TanStack Router.
// Since we import Route directly, and it might not have useParams mocked, let's mock the entire Route object or just use a proxy.
// Actually, `Route.useParams()` is called inside `RunTracePage`. We can mock `Route.useParams`.
// biome-ignore lint/suspicious/noExplicitAny: mock
Route.useParams = () => ({ runId: "run-123" }) as any;

describe("RunTracePage Shortcuts", () => {
	const mockData = {
		run: {
			id: "run-123",
			workflowName: "MyWorkflow",
			status: "completed",
			triggerType: "http",
			triggerSummary: "GET /",
			startedAt: 100,
			durationMs: 50,
		},
		nodes: [
			{ id: "node-1", stepIndex: 0, status: "completed", nodeName: "Step 1" },
			{ id: "node-2", stepIndex: 1, status: "completed", nodeName: "Step 2" },
			{ id: "node-3", stepIndex: 2, status: "failed", nodeName: "Step 3" },
		],
		logs: [],
	};

	beforeEach(() => {
		vi.mocked(useRunDetail).mockReturnValue({ data: mockData, isLoading: false, error: null } as unknown as ReturnType<
			typeof useRunDetail
		>);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	const renderWithProvider = () => {
		return render(
			<ShortcutProvider>
				<RunTracePage />
			</ShortcutProvider>,
		);
	};

	it("switches panes on alt+1 to alt+5", async () => {
		renderWithProvider();

		// Initially, active step should be rendered. Wait, node-3 is failed, so it selects node-3.
		expect(screen.getByText("Step 3")).toBeInTheDocument(); // TraceGraph or ActiveStepPanel should render it.
		// We'll just check if mode buttons get the active class.
		const logsBtn = screen.getByText("Logs").closest("button");
		expect(logsBtn).not.toHaveClass("border-blok-green-500");

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", altKey: true }));
		});
		expect(screen.getByText("Logs").closest("button")).toHaveClass("border-blok-green-500");

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", altKey: true }));
		});
		expect(screen.getByText("Graph").closest("button")).toHaveClass("border-blok-green-500");
	});

	it("switches to step pane on escape", () => {
		renderWithProvider();
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", altKey: true }));
		});
		expect(screen.getByText("Graph").closest("button")).toHaveClass("border-blok-green-500");

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(screen.getByText("Active step").closest("button")).toHaveClass("border-blok-green-500");
	});

	it("navigates steps with j/k", () => {
		renderWithProvider();
		// Initial is failed node (node-3)
		// activeStepId should be "node-3"

		// Let's press 'k' to go to previous
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
		});
		// It should now select node-2. Let's see if there's a visual indication.
		// The active step panel renders the node.
		expect(screen.getByText("Step 2")).toBeInTheDocument();

		// Press 'j' to go next
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
		});
		expect(screen.getByText("Step 3")).toBeInTheDocument();
	});

	it("jumps to step N directly with 1-9", () => {
		renderWithProvider();

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
		});
		expect(screen.getByText("Step 1")).toBeInTheDocument();

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
		});
		expect(screen.getByText("Step 2")).toBeInTheDocument();
	});
});
