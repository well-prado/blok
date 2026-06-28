import { WorkflowV2Schema } from "./types/WorkflowOpts";

/**
 * A single validation problem, located by a dot-joined path into the document.
 */
export interface WorkflowValidationError {
	path: string;
	message: string;
}

/**
 * Result of {@link validateWorkflow}.
 *
 * - `kind: "v2"` — the doc was treated as a v2 workflow and run through
 *   {@link WorkflowV2Schema}. `ok` reflects whether it parsed.
 * - `kind: "v1"` — the doc is structurally a legacy v1 workflow (top-level
 *   `nodes{}` map, or steps using `.name`/`.node` without `.id`/`.use`).
 *   `ok` is always `false`, with a single explanatory error — v1 is handled
 *   by the runtime normalizer, NOT by this v2 validator. This avoids dumping a
 *   wall of strict v2 issues at an author who simply wrote a valid v1 file.
 * - `kind: "unknown"` — the input isn't a workflow-shaped object at all
 *   (not an object, or missing both `steps` and `nodes`). `ok` is `false`.
 */
export interface WorkflowValidationResult {
	ok: boolean;
	kind: "v2" | "v1" | "unknown";
	errors: WorkflowValidationError[];
}

/**
 * **ADVISORY** structural validation of a workflow document against the v2 IR.
 *
 * This is the single shared validator for CLI/registry/Studio/AI authoring
 * checks. It is intentionally NOT wired into the JSON load path
 * (`scanWorkflows.ts` does not Zod-validate on load), so enforcing it would be
 * a breaking change deferred to a future schemaVersion bump. Use it to surface
 * authoring problems early — never to gate loading existing workflows.
 *
 * @param json - an untrusted workflow document (parsed JSON, a TS-compiled
 *   `_config`, the `workflow()` / legacy `Workflow()` builder envelope, or any
 *   object).
 * @returns `{ ok, kind, errors }`. See {@link WorkflowValidationResult}.
 */
export function validateWorkflow(json: unknown): WorkflowValidationResult {
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		return {
			ok: false,
			kind: "unknown",
			errors: [{ path: "", message: "workflow must be an object" }],
		};
	}

	// Unwrap v2 builder envelopes — a TS `export default workflow({...})` returns
	// `{_blokV2: true, _config: {...}, toJson}`. The legacy `Workflow()` builder
	// also carries its definition under `_config`. Mirrors WorkflowNormalizer's
	// unwrap so the validator classifies the inner config, not the wrapper.
	const doc = unwrapBuilderEnvelope(json as Record<string, unknown>);
	const hasSteps = Array.isArray(doc.steps);

	// v1 detection — structural, BEFORE strict v2 parsing. A v1 doc carries a
	// top-level `nodes{}` map, or its steps use `.name`/`.node` (the v1 step
	// identity) without `.id`/`.use` (the v2 identity). Such a doc is valid and
	// loadable via the runtime normalizer; reporting it as a pile of v2 errors
	// would be noise, so we return a distinct legacy verdict instead.
	if (isV1Shaped(doc, hasSteps)) {
		return {
			ok: false,
			kind: "v1",
			errors: [
				{
					path: "",
					message: "legacy v1 workflow — handled by the runtime normalizer, not the v2 validator",
				},
			],
		};
	}

	// Not v1-shaped and not workflow-shaped at all (no steps, no nodes) → unknown.
	if (!hasSteps && !("nodes" in doc)) {
		return {
			ok: false,
			kind: "unknown",
			errors: [{ path: "", message: "not a workflow — expected a `steps` array" }],
		};
	}

	const r = WorkflowV2Schema.safeParse(doc);
	if (r.success) {
		return { ok: true, kind: "v2", errors: [] };
	}
	return {
		ok: false,
		kind: "v2",
		errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
	};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Unwrap a v2 / legacy builder envelope to its inner workflow config. Mirrors
 * `WorkflowNormalizer.normalizeWorkflow` (core/runner) so an author who passes
 * the raw `workflow()` return value gets the same classification as a plain
 * parsed JSON doc. Returns the input unchanged when it isn't an envelope.
 */
function unwrapBuilderEnvelope(wf: Record<string, unknown>): Record<string, unknown> {
	if (wf._blokV2 === true && isPlainObject(wf._config)) {
		return wf._config;
	}
	// Legacy builder shape — a `_config` payload with no top-level name/steps.
	if (isPlainObject(wf._config) && wf.name === undefined && wf.steps === undefined) {
		return wf._config;
	}
	return wf;
}

/**
 * True when the doc is structurally a legacy v1 workflow:
 * - any step that carries `.name`/`.node` (v1 step identity) but neither
 *   `.id` nor `.use` (v2 identity), OR
 * - a top-level `nodes{}` map (v1 stored node inputs separately from steps) —
 *   BUT only when no step already declares a v2 identity. A doc whose steps use
 *   `id`/`use` is genuine v2; a stray `nodes{}` map alongside it should still be
 *   classified v2 (and surfaced as a strict-schema error) rather than mislabeled.
 */
function isV1Shaped(doc: Record<string, unknown>, hasSteps: boolean): boolean {
	let anyV2Identity = false;
	if (hasSteps) {
		for (const step of doc.steps as unknown[]) {
			if (typeof step !== "object" || step === null) continue;
			const s = step as Record<string, unknown>;
			const v1Identity = "name" in s || "node" in s;
			const v2Identity = "id" in s || "use" in s;
			if (v2Identity) anyV2Identity = true;
			if (v1Identity && !v2Identity) return true;
		}
	}
	if (!anyV2Identity && isPlainObject(doc.nodes)) {
		return true;
	}
	return false;
}
