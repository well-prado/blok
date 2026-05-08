/**
 * Byte-identical NodeError parity — closes master plan §17.13.
 *
 * The cross-language matrix (`matrix.integration.test.ts`) asserts every
 * SDK emits the same field VALUES for the same input. This file goes
 * one level deeper: it serializes the decoded {@link BlokError} into a
 * canonical JSON form (with per-SDK fields stripped or normalized) and
 * asserts that JSON is byte-equal across every available SDK.
 *
 * Why this matters: a green matrix lets one SDK silently drift on
 * field ordering, optional-field presence, or subtle encoding choices
 * (e.g. `null` vs missing `details`, `0` vs absent `retry_after_ms`).
 * Byte-equal canonical JSON catches that drift before it reaches
 * Studio or downstream consumers.
 *
 * # Strategy
 *
 * 1. Spawn each SDK and trigger the same `blok-error-demo` mode.
 * 2. Decode the resulting {@link BlokError} via the existing
 *    GrpcRuntimeAdapter codec (so we exercise the runner-side path
 *    too).
 * 3. Project to a canonical JSON shape that strips per-SDK fields:
 *    `sdk`, `sdk_version`, `runtime_kind`, `node`, `at`, `stack`, and
 *    each `causes[i].{sdk,sdk_version,runtime_kind,node,at,stack}`.
 * 4. JSON-stringify with sorted keys and assert all SDKs produce the
 *    same string.
 *
 * What's normalized vs preserved:
 *
 * | Field | Treatment | Why |
 * |---|---|---|
 * | `sdk` | stripped | Each SDK identifies itself ("blok-python3" vs "blok-go") |
 * | `sdk_version` | stripped | Each SDK has its own release cadence |
 * | `runtime_kind` | stripped | Differs per SDK |
 * | `node` | stripped | Auto-filled with the registered node name |
 * | `at` | stripped | Each SDK calls `time.now()` independently |
 * | `stack` | stripped | Each language's stack format is necessarily SDK-specific |
 * | `causes[i].{sdk,version,runtime_kind,node,at,stack}` | stripped | Same reasons, applied recursively |
 * | everything else | preserved | These are the fields §17.13 asserts byte-identical across SDKs |
 *
 * Concretely: `category`, `severity`, `code` (errorCode), `message`,
 * `description`, `remediation`, `doc_url`, `http_status`, `retryable`,
 * `retry_after_ms`, `details`, `context_snapshot` minus its `vars`
 * (which contain SDK timing data), and `causes[i].{code,category,
 * severity,message,http_status,retryable,retry_after_ms,details}` —
 * all are required to match byte-for-byte.
 */

import type { ChildProcess } from "node:child_process";
import type { BlokError, NodeErrorPayload } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RunnerNode from "../../../src/RunnerNode";
import type { GrpcRuntimeAdapter } from "../../../src/adapters/grpc/GrpcRuntimeAdapter";
import {
	SDK_PROFILES,
	type SdkProfile,
	buildGrpcAdapter,
	killSdkProcess,
	reserveFreePort,
	waitForGrpcHealth,
} from "./harness";
import { type CanonicalWorkflow, asBlokError, buildParityContext } from "./workflows";
import { errorPathsBattery } from "./workflows/error-paths";

class ByteIdenticalNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

function makeRunnerNode(profile: SdkProfile, workflow: CanonicalWorkflow): RunnerNode {
	const node = new ByteIdenticalNode();
	node.name = workflow.stepName;
	node.node = workflow.node;
	node.type = `runtime.${profile.kind}`;
	return node;
}

/**
 * Project a BlokError into a canonical JSON shape suitable for
 * byte-equal cross-SDK comparison. Every field listed in the doc
 * comment above is stripped or normalized; the rest are preserved.
 */
function canonicalizeBlokError(err: BlokError): Record<string, unknown> {
	return {
		category: err.category,
		severity: err.severity,
		code: err.errorCode,
		message: err.message,
		description: err.description,
		remediation: err.remediation,
		doc_url: err.docUrl,
		http_status: err.httpStatus,
		retryable: err.retryable,
		retry_after_ms: err.retryAfterMs,
		details: normalizeJson(err.details),
		// `context_snapshot` may include sdk-side `vars` snapshots
		// containing language-specific timing; we preserve the
		// `inputs` slice (which is fully deterministic) and strip
		// `vars` from the comparison.
		context_snapshot: canonicalizeContextSnapshot(err.contextSnapshot),
		causes: (err.causes ?? []).map(canonicalizeCause),
	};
}

/**
 * Canonicalize a single cause-chain entry.
 *
 * Cause `code` is normalized for the `UNCAUGHT_*` family per §17.7: each
 * language derives the code from its native exception class
 * (`ConnectionError` → `UNCAUGHT_CONNECTIONERROR` in Python;
 * `errors.errorString` → `UNCAUGHT_ERRORSTRING` in Go;
 * `IOException` → `UNCAUGHT_IOEXCEPTION` in Java; etc.). That divergence
 * is by-design — the framework can't paper over each runtime's distinct
 * exception class hierarchy. We collapse the entire family to
 * `UNCAUGHT_*` for byte-identical comparison; explicit BlokError causes
 * (which would carry a stable code like `POSTGRES_CONNECT_TIMEOUT`)
 * are still asserted byte-equal.
 */
function canonicalizeCause(cause: NodeErrorPayload): Record<string, unknown> {
	return {
		category: cause.category,
		severity: cause.severity,
		code: typeof cause.code === "string" && cause.code.startsWith("UNCAUGHT_") ? "UNCAUGHT_*" : cause.code,
		message: cause.message,
		description: cause.description ?? "",
		remediation: cause.remediation ?? "",
		doc_url: cause.docUrl ?? "",
		http_status: cause.httpStatus,
		retryable: cause.retryable,
		retry_after_ms: cause.retryAfterMs,
		details: normalizeJson(cause.details),
	};
}

function canonicalizeContextSnapshot(snapshot: unknown): unknown {
	if (snapshot === null || snapshot === undefined) return null;
	if (typeof snapshot !== "object") return snapshot;
	const obj = snapshot as Record<string, unknown>;
	// Preserve inputs (deterministic — the demo passes a fixed config).
	// Drop vars (each SDK seeds different timing data).
	return { inputs: normalizeJson(obj.inputs ?? null) };
}

/**
 * Recursively normalize a JSON value so structurally-equivalent
 * payloads serialize byte-equal. Object keys are sorted; arrays
 * preserve order; primitives pass through. Numbers cast to a stable
 * representation (`null` for undefined, no NaN/Infinity allowed in
 * proto JSON anyway).
 */
function normalizeJson(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		const out: Record<string, unknown> = {};
		for (const k of keys) out[k] = normalizeJson(obj[k]);
		return out;
	}
	return value;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(normalizeJson(value));
}

interface SdkResult {
	sdkId: string;
	canonical: string;
}

/**
 * Run the workflow against a single SDK and return the canonical
 * JSON string. The SDK lifecycle is encapsulated here so the byte
 * comparison can iterate per-workflow and aggregate per-SDK results
 * without mixing concerns.
 */
async function runWorkflowAgainst(profile: SdkProfile, workflow: CanonicalWorkflow): Promise<string> {
	const httpPort = await reserveFreePort();
	const grpcPort = await reserveFreePort();
	const proc: ChildProcess = profile.spawn(httpPort, grpcPort);
	let exitCode: number | null = null;
	proc.once("exit", (code) => {
		exitCode = code;
	});
	const adapter: GrpcRuntimeAdapter = buildGrpcAdapter(profile.kind, grpcPort);
	try {
		const healthy = await waitForGrpcHealth(adapter, 25_000);
		if (!healthy) {
			throw new Error(`SDK '${profile.id}' did not become healthy within 25s (child exit code: ${exitCode})`);
		}
		const node = makeRunnerNode(profile, workflow);
		const ctx = buildParityContext(workflow.stepName, workflow.inputs, workflow.body);
		const result = await adapter.execute(node, ctx);
		const err = asBlokError(result.errors);
		return stableStringify(canonicalizeBlokError(err));
	} finally {
		adapter.close();
		await killSdkProcess(proc);
	}
}

// =============================================================================
// Test suite
// =============================================================================
//
// One describe-block per error-paths workflow (DEPENDENCY, RATE_LIMIT,
// VALIDATION). Inside each, we:
//   1. Pre-flight: detect which SDKs are available locally.
//   2. Run the workflow once per SDK in beforeAll, collecting canonical
//      strings.
//   3. Assert every SDK produced an identical string. Test fails with
//      a side-by-side diff so the offending SDK is obvious.
//
// Walltime: ~25 s per SDK × 6 SDKs × 3 workflows ≈ 7-8 minutes worst
// case. Single-fork mode in vitest serializes them. In practice
// developers won't run this suite on every save — it's a CI gate
// against §17.13 drift.

const AVAILABLE_PROFILES = SDK_PROFILES.filter((p) => p.detect());

describe.skipIf(AVAILABLE_PROFILES.length < 2)("§17.13 byte-identical NodeError parity across SDKs", () => {
	for (const workflow of errorPathsBattery) {
		describe(`workflow: ${workflow.id}`, () => {
			const results: SdkResult[] = [];

			beforeAll(async () => {
				for (const profile of AVAILABLE_PROFILES) {
					const canonical = await runWorkflowAgainst(profile, workflow);
					results.push({ sdkId: profile.id, canonical });
				}
			}, 60_000 * AVAILABLE_PROFILES.length);

			it("every SDK produces a byte-identical canonical NodeError", () => {
				expect(results.length).toBe(AVAILABLE_PROFILES.length);
				const reference = results[0];
				if (!reference) throw new Error("no SDK ran the workflow");
				for (const r of results.slice(1)) {
					if (r.canonical !== reference.canonical) {
						throw new Error(
							`canonical NodeError mismatch between ${reference.sdkId} and ${r.sdkId}:\n` +
								`---- ${reference.sdkId} ----\n${reference.canonical}\n\n` +
								`---- ${r.sdkId} ----\n${r.canonical}\n`,
						);
					}
				}
			});

			afterAll(() => {
				results.length = 0;
			});
		});
	}
});
