import { describe, expect, it } from "vitest";
import {
	EVIDENCE_MAX_RECORD_BYTES,
	EvidenceContractError,
	parseCompletionContract,
	parseEvidencePayload,
	parseEvidenceRecord,
	rejectModelEvidence,
	serializeEvidenceRecord,
} from "../../src/EvidenceContracts";

const validEvidence = {
	version: "1",
	id: "evidence-tests-1",
	kind: "test-result",
	claim: "repository.tests.pass",
	artifact: {
		artifact: { id: "repo-tests", kind: "test-result" },
		version: "run-42",
		digest: `sha256:${"a".repeat(64)}`,
	},
	provenance: {
		producer: { kind: "deterministic-step", id: "run-tests" },
		workflow: { name: "strict-coding", version: "1.0.0" },
		step: { id: "run-tests", index: 3, attempt: 1 },
		trace: { runId: "run-42", nodeRunId: "node-run-42" },
		interactionId: "approval-42",
	},
	verification: {
		status: "verified",
		verifier: { kind: "runner", id: "evidence-gate" },
		method: "deterministic-check",
		checkedAt: "2026-09-01T12:00:00.000Z",
		checks: [{ code: "exit.success", outcome: "passed" }],
	},
	observedAt: "2026-09-01T12:00:00.000Z",
	payload: { exitCode: 0, testCount: 12 },
} as const;

describe("evidence contracts", () => {
	it("parses a bounded record with artifact, trace, and interaction provenance", () => {
		expect(parseEvidenceRecord(validEvidence)).toEqual(validEvidence);
	});

	it("serializes normalized records deterministically", () => {
		expect(serializeEvidenceRecord(validEvidence)).toBe(JSON.stringify(validEvidence));
	});

	it("strips untrusted descriptive fields from the normalized record", () => {
		const parsed = parseEvidenceRecord({ ...validEvidence, statement: "the model says this passed" });
		expect(parsed).not.toHaveProperty("statement");
		expect(parseEvidencePayload({ passed: true, count: 12 })).toEqual({ passed: true, count: 12 });
	});

	it("accepts an all-of completion contract for verified evidence and H1-01 approval", () => {
		expect(
			parseCompletionContract({
				version: "1",
				id: "strict-coding-complete",
				mode: "all",
				requirements: [
					{
						type: "approval",
						id: "implementation-approval",
						interactionId: "approval-42",
						status: "answered",
					},
					{
						type: "evidence",
						id: "tests-passed",
						kind: "test-result",
						claim: "repository.tests.pass",
						artifactKind: "test-result",
						producers: ["deterministic-step", "runner"],
						verification: "verified",
					},
				],
			}),
		).toMatchObject({ id: "strict-coding-complete", mode: "all" });
	});

	it("rejects model prose as a producer and rejects a prose claim code", () => {
		expect(() => parseEvidenceRecord({ ...validEvidence, claim: "I inspected the repository" })).toThrow(
			EvidenceContractError,
		);
		expect(() =>
			parseEvidenceRecord({
				...validEvidence,
				provenance: { ...validEvidence.provenance, producer: { kind: "model", id: "assistant" } },
			}),
		).toThrow(EvidenceContractError);
		expect(() => rejectModelEvidence("the tests passed")).toThrow("model prose is not evidence");
	});

	it("keeps unverified records out of completion and rejects inconsistent verification results", () => {
		expect(() =>
			parseEvidenceRecord({ ...validEvidence, verification: { ...validEvidence.verification, status: "unverified" } }),
		).not.toThrow();
		expect(() =>
			parseCompletionContract({
				version: "1",
				id: "complete",
				mode: "all",
				requirements: [
					{
						type: "evidence",
						id: "tests-passed",
						kind: "test-result",
						producers: ["runner"],
						verification: "unverified",
					},
				],
			}),
		).toThrow(EvidenceContractError);
		expect(() =>
			parseEvidenceRecord({
				...validEvidence,
				verification: {
					...validEvidence.verification,
					checks: [{ code: "exit.success", outcome: "failed" }],
				},
			}),
		).toThrow("evidence record.verification.checks");
		expect(() =>
			parseEvidenceRecord({
				...validEvidence,
				verification: { ...validEvidence.verification, method: "human-approval" },
			}),
		).toThrow("human-approval must be verified by a human");
	});

	it("rejects oversized and cyclic payloads", () => {
		expect(() =>
			parseEvidenceRecord({
				...validEvidence,
				payload: Array.from({ length: 256 }, () => "x".repeat(300)),
			}),
		).toThrow("exceeds");
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => parseEvidenceRecord({ ...validEvidence, payload: cyclic })).toThrow(EvidenceContractError);
	});

	it("rejects duplicate completion requirement IDs and malformed artifact identities", () => {
		const requirement = {
			type: "evidence",
			id: "tests-passed",
			kind: "test-result",
			producers: ["runner"],
			verification: "verified",
		};
		expect(() =>
			parseCompletionContract({ version: "1", id: "complete", mode: "all", requirements: [requirement, requirement] }),
		).toThrow("requirement ids must be unique");
		expect(() =>
			parseEvidenceRecord({ ...validEvidence, artifact: { ...validEvidence.artifact, digest: "path/to/file" } }),
		).toThrow("complete hexadecimal length");
		expect(() =>
			parseEvidenceRecord({
				...validEvidence,
				artifact: { ...validEvidence.artifact, digest: `sha256:${"a".repeat(63)}` },
			}),
		).toThrow(EvidenceContractError);
	});
});
