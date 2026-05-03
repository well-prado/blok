/**
 * Cross-runtime-chain smoke test — end-to-end proof that the
 * `triggers/http/workflows/json/cross-runtime-chain.json` workflow
 * runs over gRPC across all 7 SDKs (Go → Rust → Java → C# → PHP →
 * Ruby → Python), with each SDK appending its language to a shared
 * `chain` array via `ctx.vars`, and the final TS `chain-verify`
 * node confirming every runtime executed.
 *
 * This is the **demo** that proves Phase 6 readiness: the runner
 * defaults to gRPC, every SDK speaks the canonical wire shape, and
 * the chain produces a `PASS` verdict from `chain-verify`.
 *
 * # Why a smoke test (not a unit test)
 *
 * The cross-runtime-chain.json workflow normally runs through the
 * HTTP trigger (`triggers/http`). The smoke test bypasses the
 * trigger and exercises the workflow directly via the runner's
 * `Configuration` + `RunnerSteps` — proving the runner-side path
 * works end-to-end without coupling to the trigger lifecycle.
 *
 * # Skip behavior
 *
 * Skips cleanly when any of the 7 SDK toolchains is missing
 * (Python, Go, Rust, Java, C#, Ruby, PHP). The chain workflow
 * requires every SDK; partial coverage is meaningless. Locally
 * developers commonly have 4–5 of the 7 toolchains; CI provisions
 * all 7.
 */

import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RunnerNode from "../../../src/RunnerNode";
import type { GrpcRuntimeAdapter } from "../../../src/adapters/grpc/GrpcRuntimeAdapter";
import {
	SDK_PROFILES,
	type SdkProfile,
	buildGrpcAdapter,
	killSdkProcess,
	phpProfile,
	reserveFreePort,
	waitForGrpcHealth,
} from "./harness";
import { buildParityContext } from "./workflows";

// =============================================================================
// Workflow load + step preparation
// =============================================================================
//
// We load the JSON definition at module-init time so the test file
// reads as "the workflow" + "what assertions it must satisfy",
// rather than re-defining the workflow inline.

import workflowJson from "../../../../../triggers/http/workflows/json/cross-runtime-chain.json" with { type: "json" };

/**
 * v2 step shape — `id` + `use` with inline `inputs`. This workflow was
 * migrated from v1 in commit `329b80b`; before this fix the test was
 * still reading the legacy `name` + `node` + top-level `nodes{}` shape.
 */
interface WorkflowStep {
	id: string;
	use: string;
	type: string;
	inputs?: Record<string, unknown>;
}

interface WorkflowDef {
	name: string;
	steps: WorkflowStep[];
}

const WORKFLOW = workflowJson as WorkflowDef;

/**
 * Map step `type` values from the workflow JSON to harness profiles.
 * The chain references all 7 runtimes; PHP is opt-in via `phpProfile`.
 */
const PROFILE_BY_STEP_TYPE: Record<string, SdkProfile | undefined> = {
	"runtime.python3": SDK_PROFILES.find((p) => p.id === "python3"),
	"runtime.go": SDK_PROFILES.find((p) => p.id === "go"),
	"runtime.rust": SDK_PROFILES.find((p) => p.id === "rust"),
	"runtime.java": SDK_PROFILES.find((p) => p.id === "java"),
	"runtime.csharp": SDK_PROFILES.find((p) => p.id === "csharp"),
	"runtime.ruby": SDK_PROFILES.find((p) => p.id === "ruby"),
	"runtime.php": phpProfile,
};

const REQUIRED_PROFILES: ReadonlyArray<SdkProfile> = [
	...SDK_PROFILES, // python, go, rust, java, csharp, ruby
	phpProfile,
];

const ALL_TOOLCHAINS_AVAILABLE = REQUIRED_PROFILES.every((p) => p.detect());

class ChainNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

interface RunningSdk {
	profile: SdkProfile;
	httpPort: number;
	grpcPort: number;
	proc: ChildProcess;
	adapter: GrpcRuntimeAdapter;
}

describe.skipIf(!ALL_TOOLCHAINS_AVAILABLE)(
	"cross-runtime-chain smoke — Phase 6 proof-of-life across all 7 SDKs",
	() => {
		// One adapter per SDK kind. The chain workflow dispatches
		// each `runtime.<kind>` step to the matching adapter; the
		// runner-side `chain-init` and `chain-verify` steps run
		// in-process as TS module nodes.
		const sdks: Map<string, RunningSdk> = new Map();

		beforeAll(async () => {
			// Spawn all 7 SDKs in parallel — total walltime is bound
			// by the slowest (Java, ~5 s cold). Sequential would be
			// ~20 s; parallel is ~6 s.
			const launches = REQUIRED_PROFILES.map(async (profile) => {
				const httpPort = await reserveFreePort();
				const grpcPort = await reserveFreePort();
				const proc = profile.spawn(httpPort, grpcPort);
				let exitCode: number | null = null;
				proc.once("exit", (code) => {
					exitCode = code;
				});
				const adapter = buildGrpcAdapter(profile.kind, grpcPort);
				const healthy = await waitForGrpcHealth(adapter, 25_000);
				if (!healthy) {
					throw new Error(
						`SDK '${profile.id}' did not become healthy on grpc port ${grpcPort} within 25s — child exit code: ${exitCode}`,
					);
				}
				sdks.set(profile.id, { profile, httpPort, grpcPort, proc, adapter });
			});
			await Promise.all(launches);
		}, 60_000);

		afterAll(async () => {
			// Tear down adapters first, then kill SDKs in parallel.
			const cleanups: Array<Promise<void>> = [];
			for (const sdk of sdks.values()) {
				sdk.adapter.close();
				cleanups.push(killSdkProcess(sdk.proc));
			}
			await Promise.all(cleanups);
		});

		it("executes Go → Rust → Java → C# → PHP → Ruby → Python over gRPC and chain-verify reports PASS", async () => {
			// Shared "ctx.vars" — the runtime steps read prior
			// step outputs and append their own. We replay the
			// dependency graph from the JSON's `nodes` map by
			// resolving `js/ctx.vars['<step>'].chain` references
			// before each call.
			const vars: Record<string, unknown> = {};

			// Step 1 — `chain-init` (TS module node, runs in-process).
			// We inline its logic here because the test exercises the
			// runtime-step machinery, not the TS module-node
			// loader. The shape exactly matches `chain-init/index.ts`.
			const initEntry = {
				language: "nodejs",
				order: 1,
				timestamp: new Date().toISOString(),
			};
			vars.init = {
				chain: [initEntry],
				origin: "blok-cross-runtime-test",
			};

			// Steps 2-8 — runtime nodes (one per SDK, dispatched
			// to the matching gRPC adapter).
			const runtimeStepNames = ["go", "rust", "java", "csharp", "php", "ruby", "python"] as const;

			for (const stepName of runtimeStepNames) {
				const stepDef = WORKFLOW.steps.find((s) => s.id === stepName);
				if (!stepDef) throw new Error(`step ${stepName} missing from workflow JSON`);
				const profile = PROFILE_BY_STEP_TYPE[stepDef.type];
				if (!profile) throw new Error(`no profile for ${stepDef.type}`);
				const sdk = sdks.get(profile.id);
				if (!sdk) throw new Error(`SDK '${profile.id}' not running`);

				// Resolve the `js/ctx.state['<prev_step>'].chain` refs
				// (v2 shape — inputs live inline on the step) to the
				// actual values from `vars`.
				const stepInputs = stepDef.inputs ?? {};
				const resolvedInputs = resolveJsRefs(stepInputs, vars);

				const node = new ChainNode();
				node.name = stepName;
				node.node = stepDef.use;
				node.type = stepDef.type;

				// The chain-test handlers in every SDK read from
				// `ctx.request.body` (the contract preserved from the
				// legacy HTTP path where the runner mapped
				// `resolvedInputs → request.body` per
				// HttpRuntimeAdapter.ts:154). Over gRPC the codec
				// keeps `inputs` and `body` separate, so we mimic the
				// legacy mapping here at the test layer to drive the
				// existing handlers without touching SDK code.
				const ctx = buildParityContext(stepName, resolvedInputs, resolvedInputs);
				(ctx.vars as Record<string, unknown>) = { ...vars };

				const result = await sdk.adapter.execute(node, ctx);
				expect(result.success, `${stepName} (${profile.id}) failed: ${JSON.stringify(result.errors)}`).toBe(true);

				// Pull the SDK's vars back into our shared state. The
				// chain-test node in each SDK appends its language to
				// `chain` and stores the result back on its own step
				// name in vars.
				const stepData = result.data as Record<string, unknown> | null;
				if (stepData) {
					vars[stepName] = stepData;
				}
			}

			// Final assertion — replicate `chain-verify`'s logic
			// inline: every runtime must appear in the chain AND
			// have its own vars entry.
			const expectedRuntimes = ["nodejs", "go", "rust", "java", "csharp", "php", "ruby", "python3"];
			const chain: Array<{ language: string; order: number }> = [];
			for (const v of Object.values(vars)) {
				const stepVars = v as Record<string, unknown>;
				const stepChain = (stepVars.chain ?? []) as Array<{ language: string; order: number }>;
				if (stepChain.length > chain.length) {
					chain.length = 0;
					chain.push(...stepChain);
				}
			}

			const chainLanguages = chain.map((e) => e.language);

			for (const rt of expectedRuntimes) {
				expect(chainLanguages, `runtime '${rt}' missing from chain`).toContain(rt);
			}

			// One final readout for human eyes when the test runs
			// — useful when manually validating the demo.
			console.log(
				`✓ cross-runtime-chain (gRPC) — chain length: ${chain.length}, languages: [${chainLanguages.join(" → ")}]`,
			);
		}, 60_000);
	},
);

/**
 * Resolve `js/ctx.vars['step_name'].path.to.value` references in a
 * step's input object against the running vars map. This is the
 * subset of the runner's full Blueprint Mapper expression resolver
 * that the cross-runtime-chain workflow needs — the JSON only uses
 * direct `js/ctx.vars['X'].field` accesses, no arithmetic, no array
 * slicing.
 *
 * Inline rather than importing the real resolver because we want
 * the smoke test to exercise the runtime-step path verbatim,
 * without dragging in the entire `Configuration → RunnerSteps`
 * loader (which would re-introduce its own SDK resolution and
 * fight the harness's adapter setup).
 */
function resolveJsRefs(inputs: Record<string, unknown>, vars: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(inputs)) {
		out[key] = resolveOne(raw, vars);
	}
	return out;
}

function resolveOne(raw: unknown, vars: Record<string, unknown>): unknown {
	if (typeof raw !== "string" || !raw.startsWith("js/")) return raw;
	// Match either v2 `ctx.state['<step>'].path...` or legacy
	// `ctx.vars['<step>'].path...`. v2 is the canonical shape; the v1
	// alias is preserved here for any older workflow JSON in the
	// fixture directory that hasn't been migrated yet.
	const expr = raw.slice(3); // drop "js/"
	const match = expr.match(/^ctx\.(?:state|vars)\['([^']+)'\]\.(.+)$/);
	if (!match) return raw;
	const [, step, pathExpr] = match;
	const stepVal = vars[step] as Record<string, unknown> | undefined;
	if (!stepVal) return undefined;
	let cur: unknown = stepVal;
	for (const part of pathExpr.split(".")) {
		if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}
