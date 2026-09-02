import { z } from "zod";
import { CAPABILITY_EFFECTS, type CapabilityEffect } from "./CapabilityManifest";
import {
	EVIDENCE_MAX_REQUIREMENTS,
	type EvidenceRecord,
	type EvidenceRequirement,
	EvidenceRequirementSchema,
	parseEvidenceRecord,
} from "./EvidenceContracts";
import { type CapabilityAuthority, CapabilityAuthoritySchema } from "./PermissionAlgebra";

/** Version of the language-neutral branch-join contract. */
export const JOIN_CONTRACT_VERSION = "1" as const;
export const JOIN_MAX_BRANCHES = 128;
export const JOIN_MAX_OUTPUTS = 128;
export const JOIN_MAX_SCHEMA_DEPTH = 8;
export const JOIN_MAX_CONTRACT_BYTES = 64 * 1024;

/** Version of the retry/resume idempotency contract. */
export const RETRY_RESUME_IDEMPOTENCY_CONTRACT_VERSION = "1" as const;
export const RETRY_RESUME_MAX_ATTEMPTS = 20;
export const RETRY_RESUME_MAX_RESUMES = 100;
export const RETRY_RESUME_MAX_EVIDENCE = 64;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST = /^(sha256):[0-9a-f]{64}$|^(sha512):[0-9a-f]{128}$/i;
const identifier = z.string().min(1).max(128).regex(IDENTIFIER, "must be a bounded identifier");
const pathSegment = z.union([identifier, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]);
const jsonSchema = z.union([z.boolean(), z.record(z.unknown())]);

export type JoinJsonSchema = z.infer<typeof jsonSchema>;
export type JoinBranchStatus = "completed" | "failed" | "cancelled" | "missing";

export interface JoinBranchObligation {
	readonly id: string;
	/** Optional branches may be absent; required branches must complete. */
	readonly required: boolean;
	/** Evidence required before this branch can contribute to the join. */
	readonly evidence?: readonly EvidenceRequirement[];
}

export interface JoinOutputDeclaration {
	readonly id: string;
	readonly branchId: string;
	readonly path: readonly (string | number)[];
	/** JSON Schema for the value exported from the branch. */
	readonly schema: JoinJsonSchema;
}

export interface JoinContract {
	readonly version: typeof JOIN_CONTRACT_VERSION;
	readonly id: string;
	/** `all` requires every required branch; `any` requires one completed branch. */
	readonly mode: "all" | "any";
	readonly branches: readonly JoinBranchObligation[];
	readonly outputs: readonly JoinOutputDeclaration[];
	/** Optional effective authority carried across the join boundary. */
	readonly authority?: CapabilityAuthority;
}

export interface JoinBranchResult {
	readonly id: string;
	readonly status: JoinBranchStatus;
	readonly output?: unknown;
	readonly evidence?: readonly unknown[];
}

export interface JoinResult {
	readonly branches: readonly JoinBranchResult[];
}

/** Effects use the canonical capability-manifest vocabulary (and therefore the authority algebra). */
export type RetryResumeEffect = "none" | CapabilityEffect;
export type RetryResumeIdempotencyMode = "not-required" | "keyed" | "evidence-required";

export interface RetryResumeIdempotencyContract {
	readonly version: typeof RETRY_RESUME_IDEMPOTENCY_CONTRACT_VERSION;
	readonly id: string;
	readonly stepId: string;
	readonly effect: RetryResumeEffect;
	readonly maxAttempts: number;
	readonly maxResumes: number;
	readonly idempotency: {
		readonly mode: RetryResumeIdempotencyMode;
		/** The key is deliberately a declaration, never the secret/raw value. */
		readonly keyDeclared?: boolean;
	};
	readonly evidence?: readonly EvidenceRequirement[];
	/** Optional effective authority bound to every retry/resume attempt. */
	readonly authority?: CapabilityAuthority;
}

export type EffectRetryEvidenceOutcome = "committed" | "deduplicated" | "not-committed";

export interface EffectRetryEvidence {
	readonly version: typeof RETRY_RESUME_IDEMPOTENCY_CONTRACT_VERSION;
	readonly id: string;
	readonly stepId: string;
	readonly runId: string;
	readonly attempt: number;
	readonly effect: CapabilityEffect;
	/** Digest of the resolved idempotency key; the raw key is never persisted. */
	readonly idempotencyKeyDigest: string;
	readonly outcome: EffectRetryEvidenceOutcome;
	readonly producer: {
		readonly kind: "capability" | "deterministic-step" | "runner";
		readonly id: string;
	};
	readonly observedAt: string;
}

export class JoinContractError extends Error {
	readonly code = "JOIN_REJECTED";

	constructor(
		public readonly reasonCode: string,
		message: string,
	) {
		super(`Join rejected (${reasonCode}): ${message}`);
		this.name = "JoinContractError";
	}
}

export class RetryResumeContractError extends Error {
	readonly code = "RETRY_RESUME_REJECTED";

	constructor(
		public readonly reasonCode: string,
		message: string,
	) {
		super(`Retry/resume rejected (${reasonCode}): ${message}`);
		this.name = "RetryResumeContractError";
	}
}

const joinBranchSchema = z.object({
	id: identifier,
	required: z.boolean(),
	evidence: z.array(EvidenceRequirementSchema).max(EVIDENCE_MAX_REQUIREMENTS).optional(),
});

const joinOutputSchema = z.object({
	id: identifier,
	branchId: identifier,
	path: z.array(pathSegment).max(64),
	schema: jsonSchema,
});

export const JoinBranchObligationSchema = joinBranchSchema;
export const JoinOutputDeclarationSchema = joinOutputSchema;
export const JoinContractSchema = z
	.object({
		version: z.literal(JOIN_CONTRACT_VERSION),
		id: identifier,
		mode: z.enum(["all", "any"]),
		branches: z.array(joinBranchSchema).min(1).max(JOIN_MAX_BRANCHES),
		outputs: z.array(joinOutputSchema).max(JOIN_MAX_OUTPUTS),
		authority: CapabilityAuthoritySchema.optional(),
	})
	.superRefine((value, context) => {
		const branchIds = new Set<string>();
		for (const [index, branch] of value.branches.entries()) {
			if (branchIds.has(branch.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["branches", index, "id"],
					message: "branch ids must be unique",
				});
			}
			branchIds.add(branch.id);
		}
		const outputIds = new Set<string>();
		for (const [index, output] of value.outputs.entries()) {
			if (outputIds.has(output.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["outputs", index, "id"],
					message: "output ids must be unique",
				});
			}
			outputIds.add(output.id);
			if (!branchIds.has(output.branchId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["outputs", index, "branchId"],
					message: `output references unknown branch "${output.branchId}"`,
				});
			}
		}
	});

const retryIdempotencySchema = z.object({
	mode: z.enum(["not-required", "keyed", "evidence-required"]),
	keyDeclared: z.boolean().optional(),
});

export const RetryResumeIdempotencyContractSchema = z
	.object({
		version: z.literal(RETRY_RESUME_IDEMPOTENCY_CONTRACT_VERSION),
		id: identifier,
		stepId: identifier,
		effect: z.enum(["none", ...CAPABILITY_EFFECTS]),
		maxAttempts: z.number().int().positive().max(RETRY_RESUME_MAX_ATTEMPTS),
		maxResumes: z.number().int().nonnegative().max(RETRY_RESUME_MAX_RESUMES),
		idempotency: retryIdempotencySchema,
		evidence: z.array(EvidenceRequirementSchema).max(RETRY_RESUME_MAX_EVIDENCE).optional(),
		authority: CapabilityAuthoritySchema.optional(),
	})
	.superRefine((value, context) => {
		const effectful = value.effect !== "none";
		const retriesOrResume = value.maxAttempts > 1 || value.maxResumes > 0;
		if (effectful && retriesOrResume && value.idempotency.mode === "not-required") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["idempotency", "mode"],
				message: "effectful retry/resume requires keyed idempotency or evidence",
			});
		}
		if (value.idempotency.mode === "keyed" && value.idempotency.keyDeclared !== true) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["idempotency", "keyDeclared"],
				message: "keyed idempotency requires keyDeclared: true",
			});
		}
		if (value.idempotency.mode === "evidence-required" && (!value.evidence || value.evidence.length === 0)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["evidence"],
				message: "evidence-required idempotency must declare evidence obligations",
			});
		}
	});

export const EffectRetryEvidenceSchema = z.object({
	version: z.literal(RETRY_RESUME_IDEMPOTENCY_CONTRACT_VERSION),
	id: identifier,
	stepId: identifier,
	runId: identifier,
	attempt: z.number().int().positive().max(RETRY_RESUME_MAX_ATTEMPTS),
	effect: z.enum(CAPABILITY_EFFECTS),
	idempotencyKeyDigest: z.string().max(140).regex(DIGEST, "must be a complete sha256: or sha512: digest"),
	outcome: z.enum(["committed", "deduplicated", "not-committed"]),
	producer: z.object({ kind: z.enum(["capability", "deterministic-step", "runner"]), id: identifier }),
	observedAt: z.string().min(1).max(64),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new JoinContractError("INVALID_CONTRACT", `${label}: ${result.error.message}`);
	return result.data;
}

function boundedJson(value: unknown, label: string): unknown {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new JoinContractError("INVALID_RESULT", `${label} must be JSON-serializable`);
	}
	if (new TextEncoder().encode(serialized).byteLength > JOIN_MAX_CONTRACT_BYTES) {
		throw new JoinContractError("RESULT_TOO_LARGE", `${label} exceeds ${JOIN_MAX_CONTRACT_BYTES} bytes`);
	}
	return value;
}

function atPath(value: unknown, path: readonly (string | number)[]): unknown {
	let current = value;
	for (const segment of path) {
		if (current === null || typeof current !== "object" || !(segment in current)) return undefined;
		current = (current as Record<string | number, unknown>)[segment];
	}
	return current;
}

function schemaMatches(value: unknown, schema: JoinJsonSchema, depth = 0): boolean {
	if (depth > JOIN_MAX_SCHEMA_DEPTH) return false;
	if (typeof schema === "boolean") return schema;
	const type = schema.type;
	if (typeof type === "string") {
		const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
		if (type === "integer") {
			if (typeof value !== "number" || !Number.isInteger(value)) return false;
		} else if (actual !== type) return false;
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;
	if ("const" in schema && !Object.is(schema.const, value)) return false;
	if (
		schema.required &&
		typeof schema.required === "object" &&
		Array.isArray(schema.required) &&
		typeof value === "object" &&
		value !== null
	) {
		for (const key of schema.required) {
			if (typeof key === "string" && !(key in value)) return false;
		}
	}
	if (
		schema.properties &&
		typeof schema.properties === "object" &&
		!Array.isArray(schema.properties) &&
		typeof value === "object" &&
		value !== null
	) {
		for (const [key, childSchema] of Object.entries(schema.properties)) {
			if (key in value && (typeof childSchema === "boolean" || (childSchema && typeof childSchema === "object"))) {
				if (!schemaMatches((value as Record<string, unknown>)[key], childSchema as JoinJsonSchema, depth + 1))
					return false;
			}
		}
	}
	if (
		schema.items &&
		Array.isArray(value) &&
		(typeof schema.items === "boolean" || (schema.items && typeof schema.items === "object"))
	) {
		if (!value.every((item) => schemaMatches(item, schema.items as JoinJsonSchema, depth + 1))) return false;
	}
	return true;
}

function evidenceMatches(record: EvidenceRecord, requirement: EvidenceRequirement): boolean {
	return (
		record.verification.status === "verified" &&
		record.kind === requirement.kind &&
		(requirement.claim === undefined || record.claim === requirement.claim) &&
		(requirement.artifactKind === undefined || record.artifact.artifact.kind === requirement.artifactKind) &&
		requirement.producers.includes(record.provenance.producer.kind)
	);
}

/** Validate branch completion, evidence, and declared output types at a join boundary. */
export function assertJoinSatisfied(contract: JoinContract, result: JoinResult): void {
	const parsed = parse(JoinContractSchema, contract, "join contract");
	boundedJson(result, "join result");
	const results = new Map(result.branches.map((branch) => [branch.id, branch]));
	const declaredBranchIds = new Set(parsed.branches.map((branch) => branch.id));
	for (const branch of result.branches) {
		if (!declaredBranchIds.has(branch.id)) {
			throw new JoinContractError("UNKNOWN_BRANCH", `join result contains undeclared branch "${branch.id}"`);
		}
	}
	for (const branch of parsed.branches) {
		const current = results.get(branch.id);
		if (!current || current.status === "missing") {
			if (branch.required)
				throw new JoinContractError("REQUIRED_BRANCH_MISSING", `required branch "${branch.id}" did not complete`);
			continue;
		}
		if (current.status !== "completed") {
			if (branch.required)
				throw new JoinContractError(
					"REQUIRED_BRANCH_INCOMPLETE",
					`required branch "${branch.id}" is ${current.status}`,
				);
			continue;
		}
		for (const requirement of branch.evidence ?? []) {
			const evidence = (current.evidence ?? [])
				.map((item) => {
					try {
						return parseEvidenceRecord(item);
					} catch {
						return null;
					}
				})
				.filter((item): item is EvidenceRecord => item !== null);
			if (!evidence.some((item) => evidenceMatches(item, requirement))) {
				throw new JoinContractError(
					"EVIDENCE_MISSING",
					`branch "${branch.id}" is missing evidence requirement "${requirement.id}"`,
				);
			}
		}
	}
	if (parsed.mode === "any" && !parsed.branches.some((branch) => results.get(branch.id)?.status === "completed")) {
		throw new JoinContractError("NO_BRANCH_COMPLETED", "an any-mode join requires at least one completed branch");
	}
	for (const output of parsed.outputs) {
		const branch = results.get(output.branchId);
		if (!branch || branch.status !== "completed") {
			if (parsed.branches.find((item) => item.id === output.branchId)?.required) {
				throw new JoinContractError("OUTPUT_BRANCH_MISSING", `output "${output.id}" has no completed branch source`);
			}
			continue;
		}
		const value = atPath(branch.output, output.path);
		if (value === undefined) throw new JoinContractError("OUTPUT_MISSING", `declared output "${output.id}" is missing`);
		if (!schemaMatches(value, output.schema))
			throw new JoinContractError("OUTPUT_TYPE_INVALID", `declared output "${output.id}" does not match its schema`);
	}
}

export function parseJoinContract(value: unknown): JoinContract {
	return parse(JoinContractSchema, value, "join contract");
}

export function serializeJoinContract(value: unknown): string {
	return JSON.stringify(parseJoinContract(value));
}

export function parseRetryResumeIdempotencyContract(value: unknown): RetryResumeIdempotencyContract {
	const result = RetryResumeIdempotencyContractSchema.safeParse(value);
	if (!result.success) throw new RetryResumeContractError("INVALID_CONTRACT", result.error.message);
	return result.data;
}

export function parseEffectRetryEvidence(value: unknown): EffectRetryEvidence {
	const result = EffectRetryEvidenceSchema.safeParse(value);
	if (!result.success) throw new RetryResumeContractError("INVALID_EVIDENCE", result.error.message);
	return result.data;
}

/** Require an evidence record for effectful retry/resume; no effect is retried without proof. */
export function assertEffectRetryEvidence(
	contract: RetryResumeIdempotencyContract,
	evidence: readonly unknown[],
): void {
	const parsed = parseRetryResumeIdempotencyContract(contract);
	if (parsed.effect === "none" || (parsed.maxAttempts === 1 && parsed.maxResumes === 0)) return;
	if (parsed.idempotency.mode === "not-required") {
		throw new RetryResumeContractError(
			"IDEMPOTENCY_REQUIRED",
			`effectful step "${parsed.stepId}" cannot retry or resume without idempotency`,
		);
	}
	if (parsed.idempotency.mode !== "evidence-required") return;
	const valid = evidence
		.map((item) => {
			try {
				return parseEffectRetryEvidence(item);
			} catch {
				return null;
			}
		})
		.filter((item): item is EffectRetryEvidence => item !== null);
	for (const requirement of parsed.evidence ?? []) {
		const found = valid.some(
			(item) => item.stepId === parsed.stepId && item.producer.kind === "runner" && item.id === requirement.id,
		);
		if (!found)
			throw new RetryResumeContractError(
				"EVIDENCE_MISSING",
				`missing retry evidence "${requirement.id}" for step "${parsed.stepId}"`,
			);
	}
}
