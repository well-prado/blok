import { ShortcutProvider } from "@/components/providers/ShortcutProvider";
import type { WorkflowRun } from "@/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunsTable } from "./RunsTable";

// Mock the router since RunsTable uses <Link> and useNavigate
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<unknown>("@tanstack/react-router");
	return {
		...(actual as Record<string, unknown>),
		Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: { runId?: string } }) => (
			<a href={`${to}?runId=${params?.runId}`}>{children}</a>
		),
		useNavigate: () => vi.fn(),
	};
});

// Mock the API calls
vi.mock("@/lib/api", () => ({
	cancelRun: vi.fn().mockResolvedValue({}),
	replayRun: vi.fn().mockResolvedValue({}),
	addRunTags: vi.fn().mockResolvedValue({}),
}));

describe("RunsTable Shortcuts", () => {
	const mockRuns = [
		{
			id: "run-1",
			workflowName: "wf-1",
			workflowPath: "",
			triggerSummary: "",
			status: "completed",
			triggerType: "http",
			durationMs: 100,
			startedAt: 0,
			completedNodes: 1,
			nodeCount: 1,
			tags: [],
		},
		{
			id: "run-2",
			workflowName: "wf-2",
			workflowPath: "",
			triggerSummary: "",
			status: "running",
			triggerType: "http",
			durationMs: 100,
			startedAt: 0,
			completedNodes: 1,
			nodeCount: 2,
			tags: [],
		},
		{
			id: "run-3",
			workflowName: "wf-3",
			workflowPath: "",
			triggerSummary: "",
			status: "failed",
			triggerType: "worker",
			durationMs: 100,
			startedAt: 0,
			completedNodes: 0,
			nodeCount: 1,
			tags: [],
		},
	];

	const defaultProps = {
		runs: mockRuns as unknown as WorkflowRun[],
		total: 3,
		page: 1,
		limit: 10,
		onPageChange: vi.fn(),
		enableBulk: true,
	};

	it("moves cursor with j and k, and selects with x", async () => {
		const user = userEvent.setup();

		render(
			<ShortcutProvider>
				<RunsTable {...defaultProps} />
			</ShortcutProvider>,
		);

		// Press j twice to move to run-2 (index 1) then run-3 (index 2)
		await user.keyboard("j");
		await user.keyboard("j");
		// Press k once to move back to run-2 (index 1)
		await user.keyboard("k");

		// Press x to toggle selection for run-2
		await user.keyboard("x");

		// Check if the bulk checkbox for run-2 is checked
		// The checkbox logic: title="Select" button will have a <Check /> icon inside if selected.
		// Since we don't have aria-checked, we can check the class or just use the title
		const row2Checkbox = screen.getAllByTitle("Select")[1] as HTMLElement;
		expect(row2Checkbox.className).toContain("bg-blok-green-500");

		// Press j to move to run-3 (index 2)
		await user.keyboard("j");
		// Press x to toggle selection for run-3
		await user.keyboard("x");

		const row3Checkbox = screen.getAllByTitle("Select")[2] as HTMLElement;
		expect(row3Checkbox.className).toContain("bg-blok-green-500");
	});
});
