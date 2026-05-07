/**
 * Cross-language parity matrix — master plan §6.5 + §13 + §17.13.
 *
 * For every available SDK × every canonical workflow, this test runs the
 * workflow over gRPC and asserts the workflow's invariants. Because the
 * invariants are written without SDK-specific knowledge, a green matrix
 * proves every language converges on the same observable wire shape:
 *
 *   - Same `success` flag for the same input.
 *   - Same `data` shape (modulo timestamps + language identifiers).
 *   - Same `BlokError` envelope for the same `mode` (category, code,
 *     http_status, retryable, retry_after_ms, details, doc_url, causes).
 *
 * This is the §17.13 "byte-identical NodeError parity" coverage at the
 * matrix level — each SDK's per-language E2E test asserts its OWN
 * outputs; the matrix asserts every SDK converges on the SAME outputs.
 *
 * # SDK toolchain detection
 *
 * Each SDK profile self-detects via {@link SdkProfile.detect}; missing
 * toolchains gracefully `describe.skip` instead of failing CI. Locally
 * developers will typically have a subset (Python + Go + Rust is the
 * common minimum); the full matrix runs in CI where all 6 toolchains
 * are pre-provisioned. PHP runs in its own per-language test
 * (`php-grpc.integration.test.ts`) because RoadRunner has a different
 * lifecycle model — see harness.ts for the rationale.
 *
 * # Walltime expectations
 *
 * The matrix re-spawns each SDK once (per `describe` block) and reuses
 * the gRPC channel across all canonical workflows. With 6 SDKs × 5
 * workflows ≈ 30 RPC round-trips total, the matrix completes in well
 * under one minute on a developer machine when all toolchains are
 * present (Python + Go + Rust + Java + C# + Ruby ≈ 25 s).
 */

import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, it } from "vitest";
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
import { CANONICAL_WORKFLOWS, type CanonicalWorkflow, buildParityContext } from "./workflows";
import { buildLargeVarsContext } from "./workflows/large-vars";

class ParityNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

function makeRunnerNode(profile: SdkProfile, workflow: CanonicalWorkflow): RunnerNode {
	const node = new ParityNode();
	node.name = workflow.stepName;
	node.node = workflow.node;
	node.type = `runtime.${profile.kind}`;
	return node;
}

/**
 * Build the workflow's context. Most workflows use the standard
 * {@link buildParityContext} helper; `large-vars` needs the seeded
 * 80 KB vars map so it has its own constructor.
 */
function makeContext(workflow: CanonicalWorkflow) {
	if (workflow.id === "large-vars") {
		return buildLargeVarsContext();
	}
	return buildParityContext(workflow.stepName, workflow.inputs, workflow.body);
}

for (const profile of SDK_PROFILES) {
	const available = profile.detect();
	const suiteName = `parity matrix ↔ ${profile.id}`;

	describe.skipIf(!available)(suiteName, () => {
		let httpPort: number;
		let grpcPort: number;
		let proc: ChildProcess | null = null;
		let adapter: GrpcRuntimeAdapter | null = null;

		beforeAll(async () => {
			httpPort = await reserveFreePort();
			grpcPort = await reserveFreePort();
			proc = profile.spawn(httpPort, grpcPort);
			// Surface the child exit code if the boot stalls — silent boot
			// failures are the most common matrix-flake symptom.
			let exitCode: number | null = null;
			proc.once("exit", (code) => {
				exitCode = code;
			});
			adapter = buildGrpcAdapter(profile.kind, grpcPort);
			const healthy = await waitForGrpcHealth(adapter, 25_000);
			if (!healthy) {
				throw new Error(
					`SDK '${profile.id}' did not become healthy on grpc port ${grpcPort} within 25s — toolchain installed but server failed to start (child exit code: ${exitCode})`,
				);
			}
		}, 35_000);

		afterAll(async () => {
			adapter?.close();
			await killSdkProcess(proc);
		});

		for (const workflow of CANONICAL_WORKFLOWS) {
			it(`${workflow.id}: ${workflow.description}`, async () => {
				const node = makeRunnerNode(profile, workflow);
				const ctx = makeContext(workflow);
				if (adapter === null) throw new Error("adapter missing");
				const result = await adapter.execute(node, ctx);
				workflow.assertResult(result);
			});
		}
	});
}
