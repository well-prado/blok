/**
 * Phase 5.3 — switch case `when` literal <-> text round-trip.
 *
 * `switch.cases[n].when` is `z.unknown()` on the runtime schema
 * (core/workflow-helper/src/types/StepOpts.ts:830-835): a literal scalar
 * (string/number/boolean/null) for `on === when` matching, or an array for
 * `array.includes(on)` grouping. `on`/`in` themselves resolve through the
 * SAME blueprint mapper regular step `inputs` use (`js/...` prefix — see
 * core/runner/src/Configuration.ts:337-339 and core/shared/src/NodeBase.ts's
 * `blueprintMapper`), unlike branch `when` which is raw `ctx.*` JS (ADR
 * 0004). Case `when` values are match literals, not expressions, and are
 * NOT mapper-resolved unless they happen to start with `js/` (irEditOps.ts's
 * `renameStep` only rewrites a case `when` when it looks like a state ref).
 *
 * The editor's case row is a single text field, so:
 *  - `formatCaseLiteral` turns the current value into editable text — a
 *    plain string round-trips unquoted (matching real workflow JSON, e.g.
 *    `"when": "physical"` in
 *    triggers/http/workflows/json/v05-nested-control-flow.json); anything
 *    else is JSON-stringified.
 *  - `parseCaseLiteral` is the inverse: valid JSON (a number, boolean, null,
 *    quoted string, or array) parses to its real type; anything else (the
 *    common case — a bare word like `physical`) is kept as a plain string,
 *    matching how case values actually appear in shipped workflows.
 */

export function formatCaseLiteral(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function parseCaseLiteral(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
