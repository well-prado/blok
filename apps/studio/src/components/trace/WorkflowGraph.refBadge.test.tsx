import { NodeShell, RefDiagnosticsContext } from "@/components/trace/WorkflowGraph";
import type { RefDiagnostic } from "@/lib/refDiagnostics";
import { render, screen } from "@testing-library/react";
import { Wrench } from "lucide-react";
import { describe, expect, it } from "vitest";

// #691 — the canvas marker. One badge in `NodeShell` covers every node kind,
// fed by `RefDiagnosticsContext` from the graph.

const diagnostic: RefDiagnostic = {
	severity: "error",
	code: "unknown-field",
	path: "steps[1].inputs.v",
	step: "respond",
	producer: "project",
	refPath: "readModelServed",
	fields: ["eventsApplied", "lastSeq"],
	message: 'Step "respond" reads `project.readModelServed`, which is not declared.\n  fix: …',
};

function shell(stepId: string, byStep: Map<string, RefDiagnostic[]>) {
	return render(
		<RefDiagnosticsContext.Provider value={byStep}>
			<NodeShell
				icon={Wrench}
				iconClass="text-zinc-300"
				iconTile="bg-zinc-700/60"
				title="respond"
				accent="border-zinc-800"
				stepId={stepId}
			/>
		</RefDiagnosticsContext.Provider>,
	);
}

describe("canvas ref marker", () => {
	it("marks the READING step, with the producer's fields in the tooltip", () => {
		shell("respond", new Map([["respond", [diagnostic]]]));
		const badge = screen.getByText(/^ref/);
		expect(badge).toBeInTheDocument();
		expect(badge.getAttribute("title")).toContain("readModelServed");
		expect(badge.getAttribute("title")).toContain("available: eventsApplied, lastSeq");
	});

	it("leaves a clean step unmarked", () => {
		shell("project", new Map([["respond", [diagnostic]]]));
		expect(screen.queryByText(/^ref/)).toBeNull();
	});
});
