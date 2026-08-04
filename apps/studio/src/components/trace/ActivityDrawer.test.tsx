import type { BrowserArtifact, NodeRun } from "@/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActivityDrawer } from "./ActivityDrawer";

const artifact: BrowserArtifact = {
	id: "artifact-1",
	runId: "run-1",
	nodeRunId: "node-1",
	kind: "screenshot",
	name: "assert-text-after",
	mimeType: "image/png",
	size: 123,
	createdAt: 1,
	url: "/__blok/artifacts/artifact-1",
};

const assertion = {
	id: "node-1",
	runId: "run-1",
	nodeName: "check-title",
	nodeType: "module",
	status: "completed",
	startedAt: 1,
	finishedAt: 2,
	depth: 0,
	stepIndex: 0,
	outputs: { pass: true, expected: "Welcome", actual: "Welcome" },
	artifacts: [artifact],
} satisfies NodeRun;

describe("ActivityDrawer", () => {
	it("shows assertion results and selects an artifact with its node", async () => {
		const onSelectNode = vi.fn();
		const onSelectArtifact = vi.fn();
		const user = userEvent.setup();
		render(
			<ActivityDrawer
				nodes={[assertion]}
				logs={[]}
				stepUses={{ "check-title": "@blokjs/browser-assert-text" }}
				selectedNodeId={null}
				onSelectNode={onSelectNode}
				onSelectArtifact={onSelectArtifact}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /assertions/i }));
		expect(screen.getByText("expected · Welcome")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /check-title/i }));
		expect(onSelectNode).toHaveBeenCalledWith("node-1");

		await user.click(screen.getByRole("button", { name: /artifacts/i }));
		await user.click(screen.getByRole("button", { name: /assert-text-after/i }));
		expect(onSelectArtifact).toHaveBeenCalledWith(artifact, "node-1");
	});
});
