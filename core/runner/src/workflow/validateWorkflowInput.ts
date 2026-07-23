/**
 * ADR 0015 — enforce a workflow's declared `input` Zod at the trigger boundary.
 *
 * The `input` schema on `workflow({ input })` was advertised (MCP tool
 * `inputSchema`) and used for TS inference, but never validated at runtime — so
 * malformed calls ran with raw/undefined fields and declared `.default()`s were
 * never applied. This closes the gap from the single `TriggerBase.run()`
 * chokepoint, scoped to the request-shaped triggers (http/mcp/grpc) — see
 * `shouldRunInputGate` for why worker/cron/pubsub and deferred re-entry are
 * excluded.
 *
 * The live Zod object only survives on the `WorkflowRegistry` entry — a schema
 * dies in `Configuration`'s `JSON.parse(JSON.stringify(...))` clone — so we read
 * it the same way the MCP trigger does (`_config.input`, falling back to a plain
 * object's top-level `input`).
 */

import { GlobalError, WORKFLOW_INPUT_VALIDATION } from "@blokjs/shared";
import { WorkflowRegistry } from "./WorkflowRegistry";

/** A duck-typed Zod schema — anything with a `safeParse`. */
interface SafeParseable {
	safeParse: (data: unknown) => { success: true; data: unknown } | { success: false; error: unknown };
}

interface ZodIssueLike {
	path: (string | number)[];
	message: string;
	code: string;
}

function isSafeParseable(v: unknown): v is SafeParseable {
	return !!v && typeof (v as { safeParse?: unknown }).safeParse === "function";
}

/**
 * Decide whether the ADR 0015 input gate should run for this invocation.
 * Encodes the fixes the ctx-integrity audit surfaced:
 *
 *  - **Skip on deferred re-entry.** The gate mutates `ctx.request.body` in place;
 *    on the first pass the body is already validated + normalized. Re-running on
 *    a delay/debounce/queue/durable-recovery re-entry would re-parse the parsed
 *    value — double-applying a non-idempotent `.transform()`, or throwing 400 on
 *    a type-changing one *after* the client already received 202.
 *  - **Scope by the INVOKING trigger, not the declared config.** Only http / mcp
 *    / grpc drive validation — the triggers whose `ctx.request.body` IS the
 *    caller payload the schema describes. `invokingTriggerValidates` comes from
 *    `TriggerBase.validatesDeclaredInput()` (overridden true only in those three),
 *    so it reflects which trigger actually fired. Keying on the workflow's
 *    *declared* trigger config would mis-fire for a multi-trigger workflow (e.g.
 *    `{ http, worker }`) invoked via its worker/cron/pubsub side, validating a
 *    job/cron/message payload the schema was never written against.
 */
export function shouldRunInputGate(opts: {
	hasRequest: boolean;
	isReentry: boolean;
	/** `process.env.BLOK_VALIDATE_WORKFLOW_INPUT` — "0" disables the gate. */
	killSwitch: string | undefined;
	/** `this.validatesDeclaredInput()` — true only for http/mcp/grpc triggers. */
	invokingTriggerValidates: boolean;
}): boolean {
	return opts.hasRequest && !opts.isReentry && opts.killSwitch !== "0" && opts.invokingTriggerValidates;
}

/**
 * Resolve the declared input Zod for a workflow by name from the process
 * registry. Returns `undefined` when the workflow is unregistered or declares
 * no `input` — both mean "no enforcement", the correct default.
 */
export function resolveDeclaredInputSchema(name: string | undefined): SafeParseable | undefined {
	if (!name) return undefined;
	const entry = WorkflowRegistry.getInstance().get(name);
	if (!entry) return undefined;
	const wf = (entry.workflow as { _config?: unknown })?._config ?? entry.workflow;
	const input = (wf as { input?: unknown } | undefined)?.input;
	return isSafeParseable(input) ? input : undefined;
}

/**
 * Parse `body` against `schema`. On success returns the parsed value — Zod
 * defaults and coercions applied, unknown keys stripped — which the caller
 * writes back onto `ctx.request.body`. On failure throws a `GlobalError` with
 * code 400 and the same structured `validation_errors` body the node-level Zod
 * gate produces (`defineNode.zodErrorToGlobalError`), so HTTP renders a 400,
 * MCP an `isError:true` result, and gRPC an error status — all via existing
 * transport handling.
 *
 * No schema → returns `body` untouched (no-op).
 */
export function parseWorkflowInput(schema: SafeParseable | undefined, body: unknown): unknown {
	if (!schema) return body;
	const result = schema.safeParse(body);
	if (result.success) return result.data;

	const issues = readIssues(result.error);
	const summary = issues.map((i) => `${i.path.join(".") || "(root)"} (${i.message})`).join(", ");
	const err = new GlobalError(`Input validation failed: ${summary}`);
	err.setCode(400);
	// ADR 0015 — stable tag so triggers (worker/pubsub/webhook) recognize this as
	// a deterministic validation failure and route it to DLQ / a 4xx response
	// instead of a poison-message retry loop. See `isNonRetryableValidationError`.
	err.setName(WORKFLOW_INPUT_VALIDATION);
	err.setJson({
		validation_errors: issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
	});
	throw err;
}

/** ZodError in v3 exposes `.issues` (`.errors` is a legacy alias). */
function readIssues(error: unknown): ZodIssueLike[] {
	const e = error as { issues?: ZodIssueLike[]; errors?: ZodIssueLike[] };
	return e?.issues ?? e?.errors ?? [];
}
