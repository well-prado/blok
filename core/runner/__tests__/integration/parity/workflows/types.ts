/**
 * Cross-language parity workflow contract.
 *
 * Each {@link CanonicalWorkflow} is a transport-agnostic, SDK-agnostic
 * description of one node invocation plus the assertions every SDK must
 * satisfy for the run to count as parity-equivalent. The
 * {@link parity/matrix.integration.test.ts | matrix} parameterizes over
 * (SDK × workflow) and runs each workflow against every available SDK,
 * asserting that all SDKs converge on the same observable behavior.
 *
 * The canonical workflows are deliberately:
 * - **Built from nodes that exist in every SDK** (`hello-world`,
 *   `blok-error-demo`). No SDK-specific node dependencies.
 * - **Pure data**: no network calls, no clocks, no random sources outside
 *   the assertions' tolerance for timestamps and stack traces.
 * - **Fast**: the matrix re-spawns the SDK for each suite, so per-workflow
 *   wall-clock matters.
 */

import type { BlokError, Context } from "@blokjs/shared";
import type { ExecutionResult } from "../../../../src/adapters/RuntimeAdapter";

/**
 * Self-contained per-SDK assertion suite for one canonical workflow.
 *
 * The matrix runs `assertResult(result)` after every (SDK × transport)
 * invocation. Implementations must be deterministic — no peeking at
 * timestamps, stack traces, or other identifiably non-portable fields.
 */
export interface CanonicalWorkflow {
	/** Stable identifier (used as the test name; should be slug-safe). */
	readonly id: string;

	/** Human-readable description shown in test output. */
	readonly description: string;

	/** Node name to dispatch to. Must be registered in every SDK. */
	readonly node: string;

	/** Step name (visible in error context if assertions fail). */
	readonly stepName: string;

	/** Inputs (the per-step config map). */
	readonly inputs: Record<string, unknown>;

	/** Trigger body. Pass `null` for none. */
	readonly body: unknown;

	/**
	 * Pre-populated `ctx.vars` to send into the call.
	 *
	 * Use this to stress wire-shape limits without changing the node
	 * implementation (e.g. `large-vars` workflow seeds vars >64 KB to
	 * close BLOK_FRAMEWORK_FIXES.md #5).
	 */
	readonly preVars?: Record<string, unknown>;

	/**
	 * Whether the workflow expects success (`{success: true, errors: null}`)
	 * or a typed `BlokError` (`{success: false, errors: BlokError}`).
	 */
	readonly expectSuccess: boolean;

	/**
	 * Per-SDK assertion runner. Receives the decoded {@link ExecutionResult}
	 * and asserts the parity invariants. Throws (typically via Vitest's
	 * `expect`) on mismatch.
	 *
	 * Implementations should ignore non-portable fields like `timestamp`
	 * (each SDK formats `Time.now`/`DateTime.now` differently) and `stack`
	 * (each SDK's stack trace is necessarily SDK-specific).
	 */
	readonly assertResult: (result: ExecutionResult) => void;
}

/**
 * Summary of one matrix cell — the (SDK × workflow) pair plus a pass/fail
 * status. The matrix collects these into a final report so a single
 * failure surfaces with full attribution.
 */
export interface MatrixCellResult {
	readonly sdk: string;
	readonly workflowId: string;
	readonly passed: boolean;
	readonly error?: string;
	readonly durationMs: number;
}

/**
 * Type guard for the BlokError instance attached to a failed
 * {@link ExecutionResult}.
 */
export function asBlokError(value: unknown): BlokError {
	if (value === null || typeof value !== "object" || !("category" in value)) {
		throw new Error(`expected BlokError, got ${typeof value}: ${JSON.stringify(value)}`);
	}
	return value as BlokError;
}

/**
 * Build a minimal `Context` shape suitable for handing to a
 * {@link RuntimeAdapter}. Sets only the fields runtime adapters actually
 * read; everything else is filled with empty placeholders.
 */
export function buildParityContext(
	stepName: string,
	inputs: Record<string, unknown>,
	body: unknown,
	preVars: Record<string, unknown> = {},
): Context {
	return {
		id: "parity-matrix",
		workflow_name: "parity-matrix",
		workflow_path: "/parity",
		request: {
			body,
			headers: { "content-type": "application/json" },
			params: {},
			query: {},
			cookies: {},
			method: "POST",
			url: "/parity",
			baseUrl: "",
		} as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: { [stepName]: { inputs } } as unknown as Context["config"],
		vars: { ...preVars } as unknown as Context["vars"],
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
	};
}
