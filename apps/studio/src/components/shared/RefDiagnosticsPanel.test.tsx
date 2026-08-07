import { RefDiagnosticsPanel } from "@/components/shared/RefDiagnosticsPanel";
import type { NodeCatalogEntry } from "@/lib/api";
import { refDiagnostics } from "@/lib/refDiagnostics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// #691 — the JSON twin's diagnostics list. Same `validateRefs` result the
// canvas renders as per-node markers.

const catalog: NodeCatalogEntry[] = [
	{
		name: "projector",
		ref: "projector",
		outputSchema: {
			type: "object",
			properties: { eventsApplied: { type: "number" }, lastSeq: { type: "number" } },
			additionalProperties: false,
		},
	},
];

const definition = {
	name: "ingest",
	version: "1.0.0",
	steps: [
		{ id: "project", use: "projector", inputs: {} },
		{ id: "respond", use: "projector", inputs: { v: { $ref: { step: "project", path: ["readModelServed"] } } } },
	],
};

describe("RefDiagnosticsPanel", () => {
	it("shows the offending document path, the message, and the producer's fields", () => {
		render(<RefDiagnosticsPanel diagnostics={refDiagnostics(definition, catalog)} />);

		expect(screen.getByText("steps[1].inputs.v", { exact: false })).toBeInTheDocument();
		expect(screen.getByText(/readModelServed/)).toBeInTheDocument();
		expect(screen.getByText("eventsApplied, lastSeq")).toBeInTheDocument();
	});

	it("reports the all-clear when nothing is wrong", () => {
		render(<RefDiagnosticsPanel diagnostics={refDiagnostics({ name: "ok", steps: [] }, catalog)} />);
		expect(screen.getByText("No step-output reference problems.")).toBeInTheDocument();
	});

	it("surfaces the unchecked-step count when nodes advertise no schema", () => {
		render(<RefDiagnosticsPanel diagnostics={refDiagnostics(definition, undefined)} />);
		expect(screen.getByText(/2 step\(s\) unchecked/)).toBeInTheDocument();
	});
});
