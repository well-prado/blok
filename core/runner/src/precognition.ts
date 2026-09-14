/**
 * Precognition — Inertia's dry-run validation pass (#1011).
 *
 * A precognitive request carries `Precognition: true` and asks one question:
 * "would this submission validate?". It must therefore run the validation and
 * NOTHING else — no charge, no insert, no email. Inertia's client fires one on
 * every keystroke (debounced), so "nothing else" is not a nicety.
 *
 * The mechanism is a STEP OPTION, not trigger special-casing: a workflow marks
 * its validation step `{ precognition: true }`, and `RunnerSteps` stops right
 * after that step when — and only when — the marker header is present. A worker
 * or cron run has no such header, so the same workflow executes end to end
 * there; a workflow with no marked step is never dry-run by accident.
 *
 * The outcome is an ordinary `RespondEnvelope`, which every transport already
 * knows how to emit — so the http trigger needs no 204/422 branch of its own,
 * only the `Vary: Precognition` it must add to the OTHER responses on the route.
 *
 * `Precognition-Validate-Only: sku,qty` narrows the answer to those fields.
 *
 * ponytail: narrowing is applied to the ERRORS, not by rebuilding the schema
 * with `.pick()`. Zod validation is pure, so validating `qty` and dropping its
 * errors is observationally identical to never validating it — and error
 * filtering works for ANY validation node, at any nesting depth, without the
 * runner having to understand schemas. Upgrade path if a validator with real
 * side effects (a DB uniqueness probe) ever needs this: pass the field list to
 * the step as an input and let the node narrow its own schema.
 */

import { type Context, RESPOND_BRAND, type RespondEnvelope } from "@blokjs/shared";

/** Request header that marks a dry run. */
export const PRECOGNITION_HEADER = "precognition";
/** Request header narrowing the dry run to a comma-separated field list. */
export const PRECOGNITION_VALIDATE_ONLY = "precognition-validate-only";
/**
 * ctx marker: "this run's pipeline contains a precognition step". Set before
 * the first step executes, so the http trigger can add `Vary: Precognition` to
 * every response on the route — including the ones that are not dry runs.
 */
export const PRECOGNITION_ROUTE = "_blokPrecognitionRoute";

/** Case-insensitive read of one header off `ctx.request.headers`. */
function header(ctx: Context, name: string): string | undefined {
	const headers = (ctx.request as { headers?: Record<string, unknown> } | undefined)?.headers;
	if (!headers || typeof headers !== "object") return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name) continue;
		if (value === undefined || value === null) return undefined;
		return Array.isArray(value) ? String(value[0]) : String(value);
	}
	return undefined;
}

/**
 * The field list a dry run is scoped to, or `undefined` when this request is
 * not a dry run at all. An empty array means "every field" (no
 * `Precognition-Validate-Only`), which is why the two cases are distinct types
 * rather than one possibly-empty list.
 */
export function precognitionFields(ctx: Context): string[] | undefined {
	const marker = header(ctx, PRECOGNITION_HEADER);
	// The client sends the literal string "true"; anything else (including the
	// header being absent) is a normal request.
	if (marker?.toLowerCase() !== "true") return undefined;
	return (header(ctx, PRECOGNITION_VALIDATE_ONLY) ?? "")
		.split(",")
		.map((field) => field.trim())
		.filter((field) => field.length > 0);
}

/**
 * Keep only the errors the client asked about. `user` also keeps `user.name`
 * and `user.0.name`, so a client may narrow to a whole nested object or to one
 * leaf inside it.
 */
export function filterErrors(errors: Record<string, unknown>, only: readonly string[]): Record<string, unknown> {
	if (only.length === 0) return errors;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(errors)) {
		if (only.some((field) => key === field || key.startsWith(`${field}.`))) out[key] = value;
	}
	return out;
}

/**
 * Pull `{ ok, errors }` off a validation step's output. Tolerant on purpose:
 * the step may be `@blokjs/validate` or any node that reports errors the same
 * way, and a node that returned neither is treated as "valid" rather than
 * failing the request.
 */
export function readValidationErrors(output: unknown): Record<string, unknown> {
	if (typeof output !== "object" || output === null) return {};
	const errors = (output as { errors?: unknown }).errors;
	if (typeof errors !== "object" || errors === null || Array.isArray(errors)) return {};
	return errors as Record<string, unknown>;
}

/**
 * The dry-run response: `204` + `Precognition-Success: true` when the narrowed
 * field set is clean, `422 { errors }` otherwise. Both carry `Precognition:
 * true` and `Vary: Precognition`.
 */
export function precognitionEnvelope(errors: Record<string, unknown>): RespondEnvelope {
	const failed = Object.keys(errors).length > 0;
	return {
		[RESPOND_BRAND]: true,
		status: failed ? 422 : 204,
		headers: {
			Precognition: "true",
			Vary: "Precognition",
			...(failed ? {} : { "Precognition-Success": "true" }),
		},
		...(failed ? { body: { errors }, contentType: "application/json" } : {}),
	};
}

/**
 * The whole hook, in one call: given the finished output of a step marked
 * `precognition: true`, the envelope that should end the run — or `undefined`
 * when this request is not a dry run and the workflow must carry on.
 */
export function precognitionOutcome(ctx: Context, output: unknown): RespondEnvelope | undefined {
	const only = precognitionFields(ctx);
	if (only === undefined) return undefined;
	return precognitionEnvelope(filterErrors(readValidationErrors(output), only));
}

/**
 * The runner's call site. Publishes the dry-run envelope as the run's response
 * and answers "stop now" — `false` means this was an ordinary request and the
 * workflow continues. Called from BOTH step-completion paths (fresh execution
 * and idempotency-cache replay): a cached validation result is still a
 * validation result, and letting a cache hit fall through would run exactly the
 * side effects a dry run exists to avoid.
 */
export function applyPrecognition(ctx: Context, step: { precognition?: boolean }, output: unknown): boolean {
	if (!step.precognition) return false;
	const envelope = precognitionOutcome(ctx, output);
	if (!envelope) return false;
	// Published in the `BlokResponse` wrapper shape every module node leaves
	// behind (`{ data, contentType, success, error }`), NOT as the bare
	// envelope: the http trigger unwraps `.data` before checking the respond
	// brand, and so does the test harness when it reports `run.response`.
	(ctx as { response: unknown }).response = {
		data: envelope,
		contentType: "application/json",
		success: true,
		error: null,
	};
	return true;
}
