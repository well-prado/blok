import { describe, expect, it } from "vitest";
import {
	JoinContractError,
	RetryResumeContractError,
	assertEffectRetryEvidence,
	assertJoinSatisfied,
	parseEffectRetryEvidence,
	parseJoinContract,
	parseRetryResumeIdempotencyContract,
} from "../../src/JoinContracts";
import { CapabilityAuthoritySchema, parseCapabilityAuthority } from "../../src/PermissionAlgebra";

const digest = `sha256:${"a".repeat(64)}`;
const evidence = {
	version: "1",
	id: "tests-proof",
	kind: "test-result",
	claim: "tests.pass",
	artifact: { artifact: { id: "tests", kind: "test-result" }, version: "1", digest },
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

const join = {
	version: "1",
	id: "parallel-join",
	mode: "all",
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

describe("H1-04 join contracts", () => {
	it("uses the canonical capability authority envelope when one is carried", () => {
		const authority = parseCapabilityAuthority({
			effects: ["read", "write"],
			capabilities: ["payments.charge"],
			secrets: [],
			fragments: {},
		});
		expect(CapabilityAuthoritySchema.parse(authority)).toEqual(authority);
		expect(parseJoinContract({ ...join, authority })).toMatchObject({ authority });
	});

	it("accepts required/optional branches and typed declared outputs", () => {
		expect(parseJoinContract(join)).toEqual(join);
	});

	it("rejects duplicate branches and outputs that reference another branch", () => {
		expect(() => parseJoinContract({ ...join, branches: [join.branches[0], join.branches[0]] })).toThrow(
			"branch ids must be unique",
		);
		expect(() => parseJoinContract({ ...join, outputs: [{ ...join.outputs[0], branchId: "unknown" }] })).toThrow(
			"unknown branch",
		);
	});

	it("fails required joins when a branch or its evidence is absent", () => {
		expect(() =>
			assertJoinSatisfied(join, {
				branches: [{ id: "tests", status: "completed", output: { summary: "ok" }, evidence: [] }],
			}),
		).toThrow(JoinContractError);
		expect(() =>
			assertJoinSatisfied(join, {
				branches: [{ id: "tests", status: "completed", output: { summary: "ok" }, evidence: [evidence] }],
			}),
		).not.toThrow();
		expect(() =>
			assertJoinSatisfied(join, {
				branches: [{ id: "tests", status: "completed", output: { summary: 42 }, evidence: [evidence] }],
			}),
		).toThrow("does not match");
	});

	it("rejects undeclared branch results", () => {
		expect(() => assertJoinSatisfied(join, { branches: [{ id: "rogue", status: "completed" }] })).toThrow(
			"undeclared branch",
		);
	});
});

describe("H1-04 retry/resume idempotency contracts", () => {
	const base = {
		version: "1",
		id: "charge-safety",
		stepId: "charge",
		effect: "write",
		maxAttempts: 3,
		maxResumes: 2,
		idempotency: { mode: "evidence-required" },
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

	it("rejects effectful retries without an idempotency mode", () => {
		expect(() =>
			parseRetryResumeIdempotencyContract({ ...base, idempotency: { mode: "not-required" }, evidence: undefined }),
		).toThrow("effectful retry/resume requires");
	});

	it("requires a declared key for keyed idempotency", () => {
		expect(() => parseRetryResumeIdempotencyContract({ ...base, idempotency: { mode: "keyed" } })).toThrow(
			"keyDeclared",
		);
	});

	it("requires bounded effect evidence before an evidence-gated replay", () => {
		const contract = parseRetryResumeIdempotencyContract(base);
		expect(() => assertEffectRetryEvidence(contract, [])).toThrow(RetryResumeContractError);
		const effectEvidence = parseEffectRetryEvidence({
			version: "1",
			id: "charge-proof",
			stepId: "charge",
			runId: "run-1",
			attempt: 1,
			effect: "write",
			idempotencyKeyDigest: digest,
			outcome: "deduplicated",
			producer: { kind: "runner", id: "runner-1" },
			observedAt: "2026-09-02T12:00:00.000Z",
		});
		expect(() => assertEffectRetryEvidence(contract, [effectEvidence])).not.toThrow();
	});
});
