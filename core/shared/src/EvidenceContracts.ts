import { z } from "zod";
import {
	INTERACTION_MAX_PAYLOAD_BYTES,
	INTERACTION_MAX_PAYLOAD_DEPTH,
	INTERACTION_MAX_PAYLOAD_ITEMS,
	INTERACTION_MAX_STRING_LENGTH,
	parseInteractionPayload,
} from "./InteractionContracts";
import type { InteractionPayload } from "./InteractionContracts";

/** Version of the language-neutral evidence wire contract. */
export const EVIDENCE_CONTRACT_VERSION = "1" as const;

/** Evidence uses the same bounded JSON value envelope as H1-01 answers. */
export const EVIDENCE_MAX_RECORD_BYTES = INTERACTION_MAX_PAYLOAD_BYTES;
export const EVIDENCE_MAX_PAYLOAD_DEPTH = INTERACTION_MAX_PAYLOAD_DEPTH;
export const EVIDENCE_MAX_PAYLOAD_ITEMS = INTERACTION_MAX_PAYLOAD_ITEMS;
export const EVIDENCE_MAX_STRING_LENGTH = INTERACTION_MAX_STRING_LENGTH;
export const EVIDENCE_MAX_CHECKS = 32;
export const EVIDENCE_MAX_REQUIREMENTS = 64;

export const EVIDENCE_PRODUCER_KINDS = ["capability", "deterministic-step", "runner"] as const;
export const EVIDENCE_VERIFIER_KINDS = ["capability", "human", "runner"] as const;
export const EVIDENCE_VERIFICATION_STATUSES = ["verified", "failed", "unverified", "expired"] as const;
export const EVIDENCE_VERIFICATION_METHODS = [
	"artifact-digest",
	"schema-check",
	"deterministic-check",
	"capability-attestation",
	"human-approval",
] as const;
export const EVIDENCE_CHECK_OUTCOMES = ["passed", "failed"] as const;

export type EvidenceProducerKind = (typeof EVIDENCE_PRODUCER_KINDS)[number];
export type EvidenceVerifierKind = (typeof EVIDENCE_VERIFIER_KINDS)[number];
export type EvidenceVerificationStatus = (typeof EVIDENCE_VERIFICATION_STATUSES)[number];
export type EvidenceVerificationMethod = (typeof EVIDENCE_VERIFICATION_METHODS)[number];
export type EvidenceCheckOutcome = (typeof EVIDENCE_CHECK_OUTCOMES)[number];

/** JSON values may be persisted in evidence only inside the shared bounds. */
export type EvidencePayload = InteractionPayload;

export interface ArtifactIdentity {
	/** Stable logical identity, independent of a particular produced version. */
	readonly id: string;
	/** Artifact family, for example `test-result` or `diff`. */
	readonly kind: string;
}

export interface ArtifactVersionIdentity {
	readonly artifact: ArtifactIdentity;
	/** Immutable producer/version label for the artifact. */
	readonly version: string;
	/** Content identity. A digest is required; a locator is not trusted evidence. */
	readonly digest: string;
}

export interface EvidenceProducerIdentity {
	readonly kind: EvidenceProducerKind;
	/** Stable capability, step, or runner identity. */
	readonly id: string;
}

export interface EvidenceTraceIdentity {
	/** H1-01-compatible durable workflow run identity. */
	readonly runId: string;
	/** Optional node-run identity from the existing trace model. */
	readonly nodeRunId?: string;
}

export interface EvidenceProvenanceIdentity {
	readonly producer: EvidenceProducerIdentity;
	readonly workflow: {
		readonly name: string;
		readonly version?: string;
	};
	readonly step: {
		readonly id: string;
		readonly index?: number;
		readonly attempt?: number;
	};
	readonly trace: EvidenceTraceIdentity;
	/** H1-01 interaction id when an approval contributed to provenance. */
	readonly interactionId?: string;
}

export type EvidenceArtifactIdentity = ArtifactVersionIdentity;

export interface EvidenceCheck {
	/** Machine-readable check code; prose is intentionally not a check result. */
	readonly code: string;
	readonly outcome: EvidenceCheckOutcome;
}

export interface EvidenceVerifierIdentity {
	readonly kind: EvidenceVerifierKind;
	readonly id: string;
}

export interface EvidenceVerificationResult {
	readonly status: EvidenceVerificationStatus;
	readonly verifier: EvidenceVerifierIdentity;
	readonly method: EvidenceVerificationMethod;
	readonly checkedAt: string;
	readonly checks: readonly EvidenceCheck[];
	/** Stable machine-readable reason, never model-authored prose. */
	readonly reasonCode?: string;
}

export type EvidenceKind = string;

export interface EvidenceRecord {
	readonly version: typeof EVIDENCE_CONTRACT_VERSION;
	readonly id: string;
	/** Machine-readable claim type, such as `tests.pass`. */
	readonly kind: EvidenceKind;
	/** Machine-readable claim code, such as `repository.tests.pass`. */
	readonly claim: string;
	readonly artifact: EvidenceArtifactIdentity;
	readonly provenance: EvidenceProvenanceIdentity;
	readonly verification: EvidenceVerificationResult;
	readonly observedAt: string;
	readonly expiresAt?: string;
	/** Structured facts only; this is not a model explanation channel. */
	readonly payload?: EvidencePayload;
}

export interface EvidenceRequirement {
	readonly type: "evidence";
	readonly id: string;
	readonly kind: EvidenceKind;
	readonly claim?: string;
	readonly artifactKind?: string;
	readonly producers: readonly EvidenceProducerKind[];
	/** Completion can consume only a verified record. */
	readonly verification: "verified";
}

export interface ApprovalRequirement {
	readonly type: "approval";
	readonly id: string;
	/** Durable interaction id from H1-01, never an answer/prose substitute. */
	readonly interactionId: string;
	/** The interaction must have reached its accepted terminal answer. */
	readonly status: "answered";
}

export type CompletionRequirement = EvidenceRequirement | ApprovalRequirement;

export interface CompletionContract {
	readonly version: typeof EVIDENCE_CONTRACT_VERSION;
	readonly id: string;
	readonly mode: "all" | "any";
	readonly requirements: readonly CompletionRequirement[];
}

export class EvidenceContractError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid evidence contract: ${issues.join("; ")}`);
		this.name = "EvidenceContractError";
		this.issues = [...issues];
	}
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CLAIM_CODE = /^[a-z][a-z0-9._:-]{0,127}$/;
const DIGEST = /^(sha256):[0-9a-f]{64}$|^(sha512):[0-9a-f]{128}$/i;
const PRODUCER_KIND = z.enum(EVIDENCE_PRODUCER_KINDS);
const VERIFIER_KIND = z.enum(EVIDENCE_VERIFIER_KINDS);
const VERIFICATION_STATUS = z.enum(EVIDENCE_VERIFICATION_STATUSES);
const VERIFICATION_METHOD = z.enum(EVIDENCE_VERIFICATION_METHODS);
const CHECK_OUTCOME = z.enum(EVIDENCE_CHECK_OUTCOMES);

const identifier = z.string().min(1).max(128).regex(IDENTIFIER, "must be a bounded identifier");
const version = z.string().min(1).max(128).regex(VERSION, "must be a bounded version");
const claimCode = z.string().min(1).max(128).regex(CLAIM_CODE, "must be a machine-readable claim code");
const timestamp = z.string().min(1).max(64);

export const ArtifactIdentitySchema = z.object({
	id: identifier,
	kind: identifier,
});

export const ArtifactVersionIdentitySchema = z.object({
	artifact: ArtifactIdentitySchema,
	version,
	digest: z
		.string()
		.max(140)
		.regex(DIGEST, "must be a sha256: or sha512: digest with the complete hexadecimal length")
		.transform((value) => value.toLowerCase()),
});

export const EvidenceProducerIdentitySchema = z.object({
	kind: PRODUCER_KIND,
	id: identifier,
});

const workflowIdentity = z.object({
	name: identifier,
	version: version.optional(),
});

const stepIdentity = z.object({
	id: identifier,
	index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const EvidenceTraceIdentitySchema = z.object({
	runId: identifier,
	nodeRunId: identifier.optional(),
});

export const EvidenceProvenanceIdentitySchema = z.object({
	producer: EvidenceProducerIdentitySchema,
	workflow: workflowIdentity,
	step: stepIdentity,
	trace: EvidenceTraceIdentitySchema,
	interactionId: identifier.optional(),
});

export const EvidenceCheckSchema = z.object({
	code: claimCode,
	outcome: CHECK_OUTCOME,
});

export const EvidenceVerifierIdentitySchema = z.object({
	kind: VERIFIER_KIND,
	id: identifier,
});

export const EvidenceVerificationResultSchema = z
	.object({
		status: VERIFICATION_STATUS,
		verifier: EvidenceVerifierIdentitySchema,
		method: VERIFICATION_METHOD,
		checkedAt: timestamp,
		checks: z.array(EvidenceCheckSchema).min(1).max(EVIDENCE_MAX_CHECKS),
		reasonCode: claimCode.optional(),
	})
	.superRefine((value, context) => {
		const failed = value.checks.some((check) => check.outcome === "failed");
		if (value.status === "verified" && failed) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["checks"],
				message: "verified results cannot contain failed checks",
			});
		}
		if (value.status === "verified" && value.method === "human-approval" && value.verifier.kind !== "human") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["verifier", "kind"],
				message: "human-approval must be verified by a human",
			});
		}
		if (
			value.status === "verified" &&
			value.method === "capability-attestation" &&
			value.verifier.kind !== "capability"
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["verifier", "kind"],
				message: "capability-attestation must be verified by a capability",
			});
		}
	});

export const EvidencePayloadSchema = z.unknown().transform((value, context): EvidencePayload | undefined => {
	try {
		return parseInteractionPayload(value, "evidence payload");
	} catch (error) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: error instanceof Error ? error.message : "invalid payload",
		});
		return undefined;
	}
});

export const EvidenceRecordSchema = z.object({
	version: z.literal(EVIDENCE_CONTRACT_VERSION),
	id: identifier,
	kind: identifier,
	claim: claimCode,
	artifact: ArtifactVersionIdentitySchema,
	provenance: EvidenceProvenanceIdentitySchema,
	verification: EvidenceVerificationResultSchema,
	observedAt: timestamp,
	expiresAt: timestamp.optional(),
	payload: EvidencePayloadSchema.optional(),
});

export const EvidenceRequirementSchema = z.object({
	type: z.literal("evidence"),
	id: identifier,
	kind: identifier,
	claim: claimCode.optional(),
	artifactKind: identifier.optional(),
	producers: z.array(PRODUCER_KIND).min(1).max(EVIDENCE_PRODUCER_KINDS.length),
	verification: z.literal("verified"),
});

export const ApprovalRequirementSchema = z.object({
	type: z.literal("approval"),
	id: identifier,
	interactionId: identifier,
	status: z.literal("answered"),
});

export const CompletionRequirementSchema = z.discriminatedUnion("type", [
	EvidenceRequirementSchema,
	ApprovalRequirementSchema,
]);

export const CompletionContractSchema = z
	.object({
		version: z.literal(EVIDENCE_CONTRACT_VERSION),
		id: identifier,
		mode: z.enum(["all", "any"]),
		requirements: z.array(CompletionRequirementSchema).min(1).max(EVIDENCE_MAX_REQUIREMENTS),
	})
	.superRefine((value, context) => {
		const ids = new Set<string>();
		for (const [index, requirement] of value.requirements.entries()) {
			if (ids.has(requirement.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["requirements", index, "id"],
					message: "requirement ids must be unique",
				});
			}
			ids.add(requirement.id);
		}
	});

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new EvidenceContractError(
			result.error.issues.map(
				(issue) => `${label}${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""} ${issue.message}`,
			),
		);
	}
	return result.data;
}

function assertRecordSize<T>(value: T, label: string): T {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new EvidenceContractError([`${label} must be JSON-serializable`]);
	}
	if (byteLength(serialized) > EVIDENCE_MAX_RECORD_BYTES) {
		throw new EvidenceContractError([`${label} exceeds ${EVIDENCE_MAX_RECORD_BYTES} bytes`]);
	}
	return value;
}

/** Parse one bounded structured fact payload without accepting model prose as a record. */
export function parseEvidencePayload(value: unknown): EvidencePayload {
	return parseSchema(EvidencePayloadSchema, value, "evidence payload") as EvidencePayload;
}

/** Parse and normalize an evidence record at the trusted boundary. */
export function parseEvidenceRecord(value: unknown): EvidenceRecord {
	return assertRecordSize(
		parseSchema(EvidenceRecordSchema, value, "evidence record") as EvidenceRecord,
		"evidence record",
	);
}

/** Parse and normalize a completion contract at the workflow/load boundary. */
export function parseCompletionContract(value: unknown): CompletionContract {
	return assertRecordSize(parseSchema(CompletionContractSchema, value, "completion contract"), "completion contract");
}

export function serializeEvidenceRecord(value: unknown): string {
	return JSON.stringify(parseEvidenceRecord(value));
}

export function serializeCompletionContract(value: unknown): string {
	return JSON.stringify(parseCompletionContract(value));
}

/**
 * A model message is descriptive context only. It cannot be adapted into a
 * trusted record because the only accepted producer kinds are capability,
 * deterministic-step, and runner.
 */
export function rejectModelEvidence(_value: unknown): never {
	throw new EvidenceContractError([
		"model prose is not evidence; provide a capability- or deterministic-step-produced artifact and verification result",
	]);
}
