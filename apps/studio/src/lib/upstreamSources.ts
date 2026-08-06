import type { NodeCatalogEntry } from "@/lib/api";
import { walkSteps } from "@/lib/irEditOps";
import type { NodeRun } from "@/types";

/**
 * Phase 5.3 — upstream handle/value picker source list.
 *
 * Pure (no React) so it's unit-testable on its own: given the workflow IR, a
 * step id being edited, the node catalog, and the last run's node traces,
 * produce the list of "insertable" upstream sources (trigger + every step
 * strictly before the target in document order) with their fields.
 */

export interface UpstreamField {
	path: string;
	expr: string;
	type?: string;
	sample?: unknown;
}

export interface UpstreamSource {
	kind: "trigger" | "step";
	id: string;
	ref?: string;
	expr: string;
	fields: UpstreamField[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Mirrors `encodeSegment` in core/shared/src/utils/lowerRefs.ts — the same
// rule the runner's own `{$ref}` lowering uses. Step ids are commonly
// minted as `<kind>-<n>` (see irEditOps.nextId), and `ctx.state.foo-bar` is
// invalid JS (parses as subtraction), so a non-identifier segment MUST use
// bracket form.
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function stateExpr(...segments: string[]): string {
	let expr = "ctx.state";
	for (const seg of segments) {
		expr += IDENT_RE.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`;
	}
	return `js/${expr}`;
}

/** Top-level `properties` keys of a JSON Schema, with their `type` if present. */
function schemaFields(outputSchema: unknown): Array<{ key: string; type?: string }> {
	const props = isObject(outputSchema) && isObject(outputSchema.properties) ? outputSchema.properties : undefined;
	if (!props) return [];
	return Object.entries(props).map(([key, prop]) => ({
		key,
		type: isObject(prop) && typeof prop.type === "string" ? prop.type : undefined,
	}));
}

const TRIGGER_SOURCE: UpstreamSource = {
	kind: "trigger",
	id: "trigger",
	expr: "js/ctx.request.body",
	fields: [
		{ path: "body", expr: "js/ctx.request.body" },
		{ path: "query", expr: "js/ctx.request.query" },
		{ path: "headers", expr: "js/ctx.request.headers" },
	],
};

export function upstreamSources(
	definition: unknown,
	targetStepId: string,
	catalog: NodeCatalogEntry[] | undefined,
	lastRunNodes: NodeRun[] | undefined,
): UpstreamSource[] {
	const ordered: Record<string, unknown>[] = [];
	walkSteps(definition, (step) => {
		ordered.push(step);
	});
	const targetIndex = ordered.findIndex((step) => step.id === targetStepId);
	// ponytail: target not found (e.g. a step not yet persisted) → no
	// upstream steps rather than guessing at a position; trigger still shows.
	const upstream = targetIndex === -1 ? [] : ordered.slice(0, targetIndex);

	const stepSources: UpstreamSource[] = [];
	for (const step of upstream) {
		if (step.ephemeral === true) continue;
		const id = typeof step.id === "string" ? step.id : undefined;
		if (!id) continue;
		const use = typeof step.use === "string" ? step.use : undefined;
		const slot = typeof step.as === "string" && step.as.length > 0 ? step.as : id;
		const spread = step.spread === true;

		const catalogEntry =
			catalog?.find((entry) => entry.ref === use) ?? (use ? catalog?.find((entry) => entry.name === use) : undefined);

		const latestRun = lastRunNodes
			?.filter((node) => node.nodeName === id && isObject(node.outputs))
			.reduce<NodeRun | undefined>(
				(latest, node) => (!latest || node.startedAt > latest.startedAt ? node : latest),
				undefined,
			);
		const sampleOutputs = latestRun ? (latestRun.outputs as Record<string, unknown>) : undefined;

		const fieldOrder: string[] = [];
		const fieldMap = new Map<string, UpstreamField>();
		const fieldExpr = (key: string) => (spread ? stateExpr(key) : stateExpr(slot, key));
		for (const { key, type } of schemaFields(catalogEntry?.outputSchema)) {
			fieldOrder.push(key);
			fieldMap.set(key, { path: key, expr: fieldExpr(key), type });
		}
		if (sampleOutputs) {
			for (const key of Object.keys(sampleOutputs)) {
				const existing = fieldMap.get(key);
				if (existing) existing.sample = sampleOutputs[key];
				else {
					fieldOrder.push(key);
					fieldMap.set(key, { path: key, expr: fieldExpr(key), sample: sampleOutputs[key] });
				}
			}
		}

		stepSources.push({
			kind: "step",
			id,
			ref: use,
			// A spread step has no single whole-output slot (its keys merge into
			// the state root) — the root object is the closest "whole thing".
			expr: spread ? "js/ctx.state" : stateExpr(slot),
			fields: fieldOrder.map((key) => fieldMap.get(key) as UpstreamField),
		});
	}

	return [TRIGGER_SOURCE, ...stepSources];
}
