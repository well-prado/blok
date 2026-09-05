import type { CampaignCase, CampaignCaseResult, CampaignReport } from "./contracts";
import { createEnvironmentManifest } from "./report";

export interface CampaignRunOptions {
	readonly cases?: readonly CampaignCase[];
	readonly includeTiming?: boolean;
}

function unsupportedOnHost(testCase: CampaignCase): boolean {
	return testCase.supportedPlatforms !== undefined && !testCase.supportedPlatforms.includes(process.platform);
}

function deferred(testCase: CampaignCase, reason: string): CampaignCaseResult {
	return { id: testCase.id, category: testCase.category, status: "deferred", evidence: [reason] };
}

export async function runCampaign(options: CampaignRunOptions = {}): Promise<CampaignReport> {
	const cases = [...(options.cases ?? campaignCases)].sort((left, right) => left.id.localeCompare(right.id));
	const results: CampaignCaseResult[] = [];
	for (const testCase of cases) {
		if (testCase.availability !== "deterministic-local") {
			results.push(
				deferred(
					testCase,
					`${testCase.availability} coverage is not available in the deterministic local profile${
						testCase.integrationSeam ? `; seam: ${testCase.integrationSeam}` : ""
					}`,
				),
			);
			continue;
		}
		if (unsupportedOnHost(testCase)) {
			results.push(
				deferred(testCase, `host platform ${process.platform} is outside this fixture's supported platforms`),
			);
			continue;
		}
		if (!testCase.run) {
			results.push({
				id: testCase.id,
				category: testCase.category,
				status: "failed",
				evidence: [],
				error: { name: "CampaignError", message: "local case has no runner" },
			});
			continue;
		}
		const started = performance.now();
		try {
			const evidence = await testCase.run();
			results.push({
				id: testCase.id,
				category: testCase.category,
				status: "passed",
				evidence,
				...(options.includeTiming ? { durationMs: Math.round(performance.now() - started) } : {}),
			});
		} catch (error) {
			results.push({
				id: testCase.id,
				category: testCase.category,
				status: "failed",
				evidence: [],
				...(options.includeTiming ? { durationMs: Math.round(performance.now() - started) } : {}),
				error: {
					name: error instanceof Error ? error.name : "UnknownError",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}
	return {
		contractVersion: "1",
		environment: createEnvironmentManifest(),
		results,
		summary: {
			total: results.length,
			passed: results.filter((result) => result.status === "passed").length,
			failed: results.filter((result) => result.status === "failed").length,
			deferred: results.filter((result) => result.status === "deferred").length,
		},
	};
}

import {
	runCodeModeProbe,
	runFilesystemProbe,
	runGraphProbe,
	runPolicyProbe,
	runProcessProbe,
	runRecoveryProbe,
	runSecretRedactionProbe as runSecretProbe,
} from "./probes";

export const campaignCases: readonly CampaignCase[] = [
	{
		id: "security.policy-evidence",
		category: "policy/evidence",
		title: "Policy cannot be bypassed and child/parallel claims cannot widen authority",
		availability: "deterministic-local",
		governingAdrs: [
			"adr/0002-enforced-agent-workflows.md",
			"adr/0003-capabilities-effects-and-policy.md",
			"adr/0010-security-and-behavioral-conformance.md",
		],
		run: runPolicyProbe,
	},
	{
		id: "security.secrets-redaction",
		category: "secrets",
		title: "Secret canaries do not cross durable or observable boundaries",
		availability: "deterministic-local",
		governingAdrs: [
			"adr/0003-capabilities-effects-and-policy.md",
			"adr/0005-event-sourced-agent-sessions.md",
			"adr/0010-security-and-behavioral-conformance.md",
		],
		run: runSecretProbe,
	},
	{
		id: "security.filesystem-boundary",
		category: "filesystem",
		title: "Traversal, symlink, and hardlink escapes are rejected",
		availability: "deterministic-local",
		supportedPlatforms: ["linux", "darwin"],
		governingAdrs: [
			"adr/0001-layered-harness-boundaries.md",
			"adr/0003-capabilities-effects-and-policy.md",
			"adr/0010-security-and-behavioral-conformance.md",
		],
		run: runFilesystemProbe,
	},
	{
		id: "security.process-boundary",
		category: "process",
		title: "Argv, shell, special output, and ownership boundaries fail closed",
		availability: "deterministic-local",
		governingAdrs: [
			"adr/0001-layered-harness-boundaries.md",
			"adr/0003-capabilities-effects-and-policy.md",
			"adr/0010-security-and-behavioral-conformance.md",
		],
		run: runProcessProbe,
	},
	{
		id: "security.code-mode",
		category: "code-mode",
		title: "Code Mode rejects ambient escape attempts and enforces budgets",
		availability: "deterministic-local",
		governingAdrs: [
			"adr/0004-constrained-code-mode.md",
			"adr/0008-parallel-and-child-permissions.md",
			"adr/0010-security-and-behavioral-conformance.md",
		],
		run: runCodeModeProbe,
	},
	{
		id: "integrity.graph-context",
		category: "graph/context",
		title: "Derived graph data is stale/conflicting and never authoritative",
		availability: "deterministic-local",
		governingAdrs: ["adr/0007-graph-provider-and-tetrix.md", "adr/0010-security-and-behavioral-conformance.md"],
		run: runGraphProbe,
	},
	{
		id: "recovery.approvals-sessions",
		category: "recovery",
		title: "Approval identity/state and event-store restart/idempotency are durable",
		availability: "deterministic-local",
		governingAdrs: [
			"adr/0005-event-sourced-agent-sessions.md",
			"adr/0006-harness-control-plane.md",
			"adr/0010-security-and-behavioral-conformance.md",
		],
		run: runRecoveryProbe,
	},
	{
		id: "security.filesystem-race-special-file",
		category: "filesystem",
		title: "TOCTOU replacement and special-file behavior on every supported host",
		availability: "platform",
		governingAdrs: [
			"adr/0001-layered-harness-boundaries.md",
			"adr/0009-desktop-packaging.md",
			"adr/0010-security-and-behavioral-conformance.md",
		],
		integrationSeam: "trusted host/platform adapter",
	},
	{
		id: "recovery.crash-restart-infra",
		category: "recovery",
		title: "Crash/restart at every desktop and external-store boundary",
		availability: "platform",
		governingAdrs: [
			"adr/0005-event-sourced-agent-sessions.md",
			"adr/0009-desktop-packaging.md",
			"adr/0010-security-and-behavioral-conformance.md",
		],
		integrationSeam: "H4-02 desktop vertical slice and native release runners",
	},
	{
		id: "workflow.h4-02-adherence",
		category: "workflow-adherence",
		title: "Invalid transitions and skipped required phases are impossible",
		availability: "h4-02",
		governingAdrs: ["adr/0002-enforced-agent-workflows.md", "adr/0010-security-and-behavioral-conformance.md"],
		integrationSeam: "H4-02 strict workflow/session dispatcher",
	},
];
