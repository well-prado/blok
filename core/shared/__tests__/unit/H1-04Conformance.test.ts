/**
 * H1-04 contract campaign. The suite deliberately imports the shared public
 * barrel so its assertions follow the canonical wire/API surface used by
 * runner, SDK, and cross-runtime consumers.
 */
import { describe, expect, it } from "vitest";
import {
	CapabilityAuthorityError,
	JOIN_MAX_BRANCHES,
	RETRY_RESUME_MAX_ATTEMPTS,
	RetryResumeContractError,
	assertCapabilityAuthoritySubset,
	assertEffectRetryEvidence,
	assertJoinSatisfied,
	intersectCapabilityAuthorities,
	isCapabilityAuthoritySubset,
	parseCapabilityAuthority,
	parseEffectRetryEvidence,
	parseJoinContract,
	parseRetryResumeIdempotencyContract,
} from "../../src";

const parentAuthority = parseCapabilityAuthority({
	effects: ["read", "write", "network"],
	capabilities: ["workspace.read", "workspace.write", "network.http"],
	secrets: ["github.token"],
	fragments: { workspace: "repo-a", maxFiles: 10 },
});

const testEvidence = {
	version: "1",
	id: "tests-proof",
	kind: "test-result",
	claim: "tests.pass",
	artifact: { artifact: { id: "tests", kind: "test-result" }, version: "1", digest: `sha256:${"a".repeat(64)}` },
	provenance: {
		producer: { kind: "deterministic-step", id: "run-tests" },
		workflow: { name: "join-workflow" },
		step: { id: "run-tests" },
		trace: { runId: "run-1" },
	},
	verification: {
		status: "verified",
		verifier: { kind: "runner", id: "runner-1" },
		method: "deterministic-check",
		checkedAt: "2026-09-02T12:00:00.000Z",
		checks: [{ code: "tests.pass", outcome: "passed" }],
	},
	observedAt: "2026-09-02T12:00:00.000Z",
} as const;

const joinContract = {
	version: "1",
	id: "parallel-join",
	mode: "all",
	authority: parentAuthority,
	branches: [
		{
			id: "tests",
			required: true,
			evidence: [
				{
					type: "evidence",
					id: "tests-proof",
					kind: "test-result",
					claim: "tests.pass",
					producers: ["deterministic-step"],
					verification: "verified",
				},
			],
		},
		{ id: "optional-lint", required: false },
	],
	outputs: [{ id: "summary", branchId: "tests", path: ["summary"], schema: { type: "string" } }],
} as const;

describe("H1-04 authority conformance", () => {
	it("canonicalizes every authority dimension and makes intersection order-independent", () => {
		const child = parseCapabilityAuthority({
			effects: ["network", "read"],
			capabilities: ["network.http", "workspace.read"],
			secrets: ["github.token"],
			fragments: { workspace: "repo-a", maxFiles: 10 },
		});
		const expected = {
			effects: ["network", "read"],
			capabilities: ["network.http", "workspace.read"],
			secrets: ["github.token"],
			fragments: { maxFiles: 10, workspace: "repo-a" },
		};

		expect(intersectCapabilityAuthorities(parentAuthority, child)).toEqual(expected);
		expect(intersectCapabilityAuthorities(child, parentAuthority)).toEqual(expected);
		expect(Object.isFrozen(parentAuthority)).toBe(true);
		expect(Object.isFrozen(parentAuthority.fragments)).toBe(true);
	});

	it("is associative and rejects widened child dimensions with stable errors", () => {
		const readOnly = parseCapabilityAuthority({
			effects: ["read"],
			capabilities: ["workspace.read"],
			secrets: [],
			fragments: { workspace: "repo-a" },
		});
		const network = parseCapabilityAuthority({
			effects: ["network", "read"],
			capabilities: ["network.http", "workspace.read"],
			secrets: ["github.token"],
			fragments: { workspace: "repo-a" },
		});
		expect(intersectCapabilityAuthorities(parentAuthority, network, readOnly)).toEqual(
			intersectCapabilityAuthorities(parentAuthority, intersectCapabilityAuthorities(network, readOnly)),
		);

		const widened = parseCapabilityAuthority({
			effects: ["destructive", "read"],
			capabilities: ["shell.exec", "workspace.read"],
			secrets: ["aws.key"],
			fragments: { maxFiles: 10, workspace: "repo-b" },
		});
		expect(isCapabilityAuthoritySubset(readOnly, parentAuthority)).toBe(true);
		expect(isCapabilityAuthoritySubset(widened, parentAuthority)).toBe(false);
		expect(() => assertCapabilityAuthoritySubset(widened, parentAuthority)).toThrow(
			new CapabilityAuthorityError([
				"child authority.capabilities contains unauthorized value(s): shell.exec",
				"child authority.effects contains unauthorized value(s): destructive",
				'child authority.fragments.workspace is not permitted: "repo-b"',
				"child authority.secrets contains unauthorized value(s): aws.key",
			]),
		);
	});

	it("fails closed on malformed authority values", () => {
		expect(() =>
			parseCapabilityAuthority({ effects: ["unknown"], capabilities: [], secrets: [], fragments: {} }),
		).toThrow(/authority\.effects\.0 Invalid enum value/);
		expect(() =>
			parseCapabilityAuthority({ effects: [], capabilities: [], secrets: [], fragments: {}, extra: true }),
		).toThrow(/authority Unrecognized key\(s\)/);
	});
});

describe("H1-04 evidence-aware joins", () => {
	it("requires required branch evidence while allowing an absent optional branch", () => {
		expect(() =>
			assertJoinSatisfied(joinContract, {
				branches: [{ id: "tests", status: "completed", output: { summary: "ok" }, evidence: [] }],
			}),
		).toThrow("EVIDENCE_MISSING");

		expect(() =>
			assertJoinSatisfied(joinContract, {
				branches: [{ id: "tests", status: "completed", output: { summary: "ok" }, evidence: [testEvidence] }],
			}),
		).not.toThrow();
	});

	it("never treats cancellation or failure as successful completion", () => {
		for (const status of ["cancelled", "failed"] as const) {
			expect(() =>
				assertJoinSatisfied(joinContract, {
					branches: [{ id: "tests", status, output: { summary: "ok" }, evidence: [testEvidence] }],
				}),
			).toThrow("REQUIRED_BRANCH_INCOMPLETE");
		}
	});

	it("checks declared output types and rejects untrusted branch identities", () => {
		expect(() =>
			assertJoinSatisfied(joinContract, {
				branches: [{ id: "tests", status: "completed", output: { summary: 42 }, evidence: [testEvidence] }],
			}),
		).toThrow("OUTPUT_TYPE_INVALID");
		expect(() =>
			assertJoinSatisfied(joinContract, {
				branches: [{ id: "rogue", status: "completed", output: { summary: "ok" }, evidence: [testEvidence] }],
			}),
		).toThrow("UNKNOWN_BRANCH");
	});

	it("enforces bounded branch contracts and any-mode completion", () => {
		const tooManyBranches = {
			...joinContract,
			branches: Array.from({ length: JOIN_MAX_BRANCHES + 1 }, (_, index) => ({
				id: `branch-${index}`,
				required: false,
			})),
		};
		expect(() => parseJoinContract(tooManyBranches)).toThrow();

		const anyJoin = parseJoinContract({
			...joinContract,
			mode: "any",
			branches: joinContract.branches.map((branch) => ({ ...branch, required: false })),
		});
		expect(() => assertJoinSatisfied(anyJoin, { branches: [{ id: "tests", status: "cancelled" }] })).toThrow(
			"NO_BRANCH_COMPLETED",
		);
	});
});

describe("H1-04 retry/resume effect safety", () => {
	const contract = {
		version: "1",
		id: "charge-safety",
		stepId: "charge",
		effect: "write",
		maxAttempts: 3,
		maxResumes: 2,
		idempotency: { mode: "evidence-required" },
		authority: parentAuthority,
		evidence: [
			{
				type: "evidence",
				id: "charge-proof",
				kind: "effect-retry",
				producers: ["runner"],
				verification: "verified",
			},
		],
	} as const;

	it("requires idempotency for effectful retries and bounds attempts", () => {
		expect(() =>
			parseRetryResumeIdempotencyContract({ ...contract, idempotency: { mode: "not-required" }, evidence: undefined }),
		).toThrow("effectful retry/resume requires");
		expect(() =>
			parseRetryResumeIdempotencyContract({ ...contract, maxAttempts: RETRY_RESUME_MAX_ATTEMPTS + 1 }),
		).toThrow();
	});

	it("requires retry evidence before a committed effect can be resumed", () => {
		const parsed = parseRetryResumeIdempotencyContract(contract);
		expect(() => assertEffectRetryEvidence(parsed, [])).toThrow(RetryResumeContractError);

		const evidence = parseEffectRetryEvidence({
			version: "1",
			id: "charge-proof",
			stepId: "charge",
			runId: "run-1",
			attempt: 1,
			effect: "write",
			idempotencyKeyDigest: `sha256:${"b".repeat(64)}`,
			outcome: "deduplicated",
			producer: { kind: "runner", id: "runner-1" },
			observedAt: "2026-09-02T12:00:00.000Z",
		});
		expect(() => assertEffectRetryEvidence(parsed, [evidence])).not.toThrow();
	});
});
