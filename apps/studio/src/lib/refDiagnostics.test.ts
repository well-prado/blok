import type { NodeCatalogEntry } from "@/lib/api";
import { refDiagnostics, shortMessage, suggestedFields } from "@/lib/refDiagnostics";
import { describe, expect, it } from "vitest";

// #691 — Studio runs the SAME `validateRefs` pass as `blokctl check` and the
// runner's boot path, through the source alias (no Zod in the browser bundle).

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

describe("refDiagnostics", () => {
	it("flags a ref to a field the producing node does not declare", () => {
		const view = refDiagnostics(definition, catalog);
		expect(view.errors).toHaveLength(1);
		expect(view.errors[0]?.code).toBe("unknown-field");
		// keyed by the READING step so the canvas can mark the right node
		expect([...view.byStep.keys()]).toEqual(["respond"]);
	});

	it("offers the producer's declared fields as the suggestion list", () => {
		const [error] = refDiagnostics(definition, catalog).errors;
		expect(error && suggestedFields(error)).toEqual(["eventsApplied", "lastSeq"]);
		expect(error && shortMessage(error)).not.toContain("\n");
	});

	it("is clean once the ref names a declared field", () => {
		const fixed = structuredClone(definition) as { steps: Array<Record<string, unknown>> };
		const step = fixed.steps[1] as { inputs: { v: { $ref: { path: string[] } } } };
		step.inputs.v.$ref.path = ["lastSeq"];
		expect(refDiagnostics(fixed, catalog).all).toEqual([]);
	});

	it("degrades to unchecked with no catalog — never a false error", () => {
		const view = refDiagnostics(definition, undefined);
		expect(view.errors).toEqual([]);
		expect(view.uncheckedSteps).toEqual(["project", "respond"]);
	});

	it("returns an empty view for a missing definition", () => {
		expect(refDiagnostics(undefined, catalog).all).toEqual([]);
	});
});
