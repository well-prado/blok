import type { NodeCatalogEntry } from "@/lib/api";
import { type RefDiagnostic, nodeSchemaLookup, validateRefs } from "@blok/validate-refs";

/**
 * Phase — #691. Live step-output reference diagnostics for the canvas and the
 * JSON twin.
 *
 * Both surfaces call THIS function, which calls the SAME `validateRefs` pass
 * `blokctl check` and the runner's boot path use — aliased to source so the
 * bundle takes the zero-dependency module, not the Zod schema graph ADR 0011
 * measured at +24.5 kB gzip.
 *
 * Node output schemas come from the catalog Studio already fetches
 * (`GET /__blok/nodes`), which is also what answers "what fields CAN I
 * reference?" in the upstream picker — one registry, both questions.
 */

export type { RefDiagnostic } from "@blok/validate-refs";

export interface RefDiagnosticsView {
	readonly all: readonly RefDiagnostic[];
	readonly errors: readonly RefDiagnostic[];
	readonly warnings: readonly RefDiagnostic[];
	/** Step id → its diagnostics, for per-node canvas badges. */
	readonly byStep: ReadonlyMap<string, RefDiagnostic[]>;
	readonly uncheckedSteps: readonly string[];
}

const EMPTY: RefDiagnosticsView = {
	all: [],
	errors: [],
	warnings: [],
	byStep: new Map(),
	uncheckedSteps: [],
};

/**
 * Validate a workflow definition against the node catalog.
 *
 * `definition` is the RAW pre-normalization shape the runner returns (the same
 * one the canvas edits as a draft), so diagnostics track unsaved edits live.
 * A missing catalog degrades to "unchecked": root-level problems still show,
 * field checking does not.
 */
export function refDiagnostics(definition: unknown, catalog: NodeCatalogEntry[] | undefined): RefDiagnosticsView {
	if (!definition) return EMPTY;
	const result = validateRefs(definition, {
		nodes: catalog ? nodeSchemaLookup(catalog) : undefined,
	});
	if (result.diagnostics.length === 0 && result.uncheckedSteps.length === 0) return EMPTY;

	const byStep = new Map<string, RefDiagnostic[]>();
	for (const d of result.diagnostics) {
		const list = byStep.get(d.step);
		if (list) list.push(d);
		else byStep.set(d.step, [d]);
	}
	return {
		all: result.diagnostics,
		errors: result.diagnostics.filter((d) => d.severity === "error"),
		warnings: result.diagnostics.filter((d) => d.severity === "warning"),
		byStep,
		uncheckedSteps: result.uncheckedSteps,
	};
}

/**
 * The one-line form shown on the canvas / next to the JSON. The full message
 * carries hint + fix lines; the squiggle only has room for the headline.
 */
export function shortMessage(d: RefDiagnostic): string {
	return d.message.split("\n")[0] ?? d.message;
}

/**
 * "What fields CAN I reference?" — the producer's declared field list, which
 * the validator already resolved. Empty when the producer has no schema.
 */
export function suggestedFields(d: RefDiagnostic): readonly string[] {
	return d.fields ?? [];
}
