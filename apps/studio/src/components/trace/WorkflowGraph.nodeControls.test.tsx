import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Wrench } from "lucide-react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { NodeControlsContext, NodeShell } from "./WorkflowGraph";

/**
 * `NodeShell` is the shared card every step/control-flow node renders
 * through. It doesn't use any xyflow hooks, so it renders standalone
 * without mocking `@xyflow/react` (unlike WorkflowGraph.editor.test.tsx,
 * which mounts the full canvas).
 */
function shell(props: Partial<React.ComponentProps<typeof NodeShell>> = {}) {
	return <NodeShell icon={Wrench} iconClass="" iconTile="" title="step-a" accent="border-zinc-800" {...props} />;
}

describe("NodeShell — active:false / stop:true rendering state", () => {
	it("dims a skipped (active:false) card", () => {
		const { container } = render(shell({ stepId: "a", skipped: true }));
		expect(container.firstElementChild).toHaveClass("opacity-50");
		expect(container.firstElementChild).toHaveClass("border-dashed");
	});

	it("does not dim a card with neither flag set", () => {
		const { container } = render(shell({ stepId: "a" }));
		expect(container.firstElementChild).not.toHaveClass("opacity-50");
	});

	it("puts an amber dashed outline on a stop:true card", () => {
		const { container } = render(shell({ stepId: "a", stopFlag: true }));
		expect(container.firstElementChild).toHaveClass("outline-dashed");
		expect(container.firstElementChild).toHaveClass("outline-amber-400/70");
	});
});

describe("NodeShell — Skip/Stop header controls", () => {
	it("renders no controls when no NodeControlsContext is provided (read-only / run active)", () => {
		render(shell({ stepId: "a" }));
		expect(screen.queryByTitle(/skip this step/i)).not.toBeInTheDocument();
		expect(screen.queryByTitle(/stop the run before/i)).not.toBeInTheDocument();
	});

	it("renders no controls for a synthetic node with no stepId, even when controls are enabled", () => {
		render(
			<NodeControlsContext.Provider value={{ onToggleSkip: vi.fn(), onToggleStop: vi.fn() }}>
				{shell({})}
			</NodeControlsContext.Provider>,
		);
		expect(screen.queryByTitle(/skip this step/i)).not.toBeInTheDocument();
	});

	it("clicking Skip calls onToggleSkip with the step id and does not bubble to an ancestor click handler", async () => {
		const onToggleSkip = vi.fn();
		const outerClick = vi.fn();
		render(
			// biome-ignore lint/a11y/useKeyWithClickEvents: test-only propagation harness (stands in for xyflow's node click handler), not real UI
			<div onClick={outerClick}>
				<NodeControlsContext.Provider value={{ onToggleSkip, onToggleStop: vi.fn() }}>
					{shell({ stepId: "a" })}
				</NodeControlsContext.Provider>
			</div>,
		);
		await userEvent.click(screen.getByTitle(/skip this step/i));
		expect(onToggleSkip).toHaveBeenCalledWith("a");
		expect(outerClick).not.toHaveBeenCalled();
	});

	it("clicking Stop calls onToggleStop with the step id and does not bubble", async () => {
		const onToggleStop = vi.fn();
		const outerClick = vi.fn();
		render(
			// biome-ignore lint/a11y/useKeyWithClickEvents: test-only propagation harness (stands in for xyflow's node click handler), not real UI
			<div onClick={outerClick}>
				<NodeControlsContext.Provider value={{ onToggleSkip: vi.fn(), onToggleStop }}>
					{shell({ stepId: "a" })}
				</NodeControlsContext.Provider>
			</div>,
		);
		await userEvent.click(screen.getByTitle(/stop the run before/i));
		expect(onToggleStop).toHaveBeenCalledWith("a");
		expect(outerClick).not.toHaveBeenCalled();
	});
});
