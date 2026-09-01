import { CAPABILITY_EFFECTS } from "@blokjs/shared";
import { z } from "zod";

/** JSON Schema carried by the serializable workflow IR. */
export const JsonSchemaSchema = z.union([z.boolean(), z.record(z.unknown())]);
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

const IdentifierSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z][A-Za-z0-9._:/-]*$/, "must be an identifier");

/** The capabilities visible to a model during one agent phase. */
export const AgentPhaseSchema = z
	.object({
		name: IdentifierSchema.describe("Stable phase name used in traces and policy decisions."),
		capabilities: z
			.array(IdentifierSchema)
			.max(64)
			.describe("The complete capability allow-list for this phase; it is never inferred from prose."),
		effects: z
			.array(z.enum(CAPABILITY_EFFECTS))
			.max(16)
			.default([])
			.describe("Operational effects exposed by the phase."),
		secrets: z
			.array(IdentifierSchema)
			.max(32)
			.default([])
			.describe("Opaque secret reference names only; values are never part of workflow IR."),
	})
	.strict();
/** Authoring input type; defaulted fields are optional at the TS edge. */
export type AgentPhase = z.input<typeof AgentPhaseSchema>;

/** Bounded model-loop resources. All limits are ceilings, not hints. */
export const AgentBudgetSchema = z
	.object({
		maxTurns: z.number().int().positive().max(1000).optional(),
		maxDurationMs: z.number().int().positive().max(86_400_000).optional(),
		maxInputBytes: z
			.number()
			.int()
			.positive()
			.max(16 * 1024 * 1024)
			.optional(),
		maxOutputBytes: z
			.number()
			.int()
			.positive()
			.max(16 * 1024 * 1024)
			.optional(),
		maxToolCalls: z.number().int().positive().max(10_000).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, { message: "at least one budget ceiling is required" });
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

/** A runner-owned completion contract. Gate IDs are resolved before execution. */
export const CompletionContractSchema = z
	.object({
		required: z.array(IdentifierSchema).min(1).max(128).describe("Assertion/evidence gate IDs that must pass."),
		outputSchema: JsonSchemaSchema.optional().describe("Optional JSON Schema for the completed agent result."),
	})
	.strict();
export type CompletionContract = z.infer<typeof CompletionContractSchema>;

const PersistenceFields = {
	description: z.string().optional(),
	ui: z.record(z.unknown()).optional(),
	as: z.string().min(1).optional(),
	ephemeral: z.boolean().optional(),
	active: z.boolean().optional(),
	stop: z.boolean().optional(),
} as const;

/** Declarative agent/model work. The model loop is intentionally out of scope for this IR contract. */
export const V2AgentStepSchema = z
	.object({
		id: z.string().min(1),
		agentStep: z
			.object({
				objective: z
					.string()
					.min(1)
					.max(16 * 1024),
				phase: AgentPhaseSchema,
				budgets: AgentBudgetSchema.optional(),
				inputSchema: JsonSchemaSchema.optional(),
				outputSchema: JsonSchemaSchema.optional(),
				completion: CompletionContractSchema,
			})
			.strict(),
		inputs: z.record(z.unknown()).optional(),
		...PersistenceFields,
	})
	.strict()
	.refine((step) => !(step.as && step.ephemeral), {
		message: "`as` and `ephemeral` are mutually exclusive — pick one.",
		path: ["ephemeral"],
	});
export type V2AgentStep = z.infer<typeof V2AgentStepSchema>;

/** Durable human interaction. Resolution is supplied by H1-01, never by model prose. */
export const V2ApprovalStepSchema = z
	.object({
		id: z.string().min(1),
		approval: z
			.object({
				prompt: z
					.string()
					.min(1)
					.max(16 * 1024),
				inputSchema: JsonSchemaSchema.optional(),
				outputSchema: JsonSchemaSchema.optional(),
				expiresInMs: z.number().int().positive().max(86_400_000).optional(),
				reason: z.string().max(4096).optional(),
			})
			.strict(),
		inputs: z.record(z.unknown()).optional(),
		...PersistenceFields,
	})
	.strict()
	.refine((step) => !(step.as && step.ephemeral), {
		message: "`as` and `ephemeral` are mutually exclusive — pick one.",
		path: ["ephemeral"],
	});
export type V2ApprovalStep = z.infer<typeof V2ApprovalStepSchema>;

const EvidenceArtifactSchema = z
	.object({
		id: IdentifierSchema.describe("Stable artifact identifier."),
		version: z.string().min(1).max(256).describe("Producer-assigned artifact version."),
		contentHash: z.string().min(1).max(256).optional().describe("Content hash when the producer supplies one."),
		mediaType: z.string().min(1).max(256).optional(),
	})
	.strict();

const EvidenceProducerSchema = z.union([
	z
		.object({
			kind: z.literal("step"),
			step: IdentifierSchema,
			path: z.array(z.union([z.string(), z.number()])).default([]),
		})
		.strict(),
	z.object({ kind: z.literal("capability"), name: IdentifierSchema }).strict(),
]);

const EvidenceVerificationSchema = z
	.object({
		verifier: IdentifierSchema,
		status: z.enum(["pending", "verified", "failed"]),
		checkedAt: z.string().datetime().optional(),
	})
	.strict();

const AssertionReferenceSchema = z
	.object({
		$ref: z
			.object({
				step: IdentifierSchema,
				path: z.array(z.union([z.string(), z.number()])).optional(),
			})
			.strict(),
	})
	.strict();

/** Provenance record for trusted, bounded evidence. It has no free-form proof field. */
export const V2EvidenceStepSchema = z
	.object({
		id: z.string().min(1),
		evidence: z
			.object({
				producer: EvidenceProducerSchema,
				artifact: EvidenceArtifactSchema,
				verification: EvidenceVerificationSchema,
			})
			.strict(),
		...PersistenceFields,
	})
	.strict();
export type V2EvidenceStep = z.infer<typeof V2EvidenceStepSchema>;

/** Deterministic assertion gate over a boolean reference or an evidence record. */
export const V2AssertStepSchema = z
	.object({
		id: z.string().min(1),
		assert: z
			.object({
				condition: z.union([z.boolean(), AssertionReferenceSchema]).optional(),
				evidence: IdentifierSchema.optional(),
				message: z.string().max(4096).optional(),
			})
			.strict()
			.refine((value) => (value.condition !== undefined) !== (value.evidence !== undefined), {
				message: "exactly one of `condition` or `evidence` is required",
			}),
		...PersistenceFields,
	})
	.strict();
export type V2AssertStep = z.infer<typeof V2AssertStepSchema>;

/** Explicit runner-owned terminal contract; model output cannot satisfy it by assertion. */
export const V2CompletionStepSchema = z
	.object({
		id: z.string().min(1),
		completion: CompletionContractSchema,
		...PersistenceFields,
	})
	.strict();
export type V2CompletionStep = z.infer<typeof V2CompletionStepSchema>;
