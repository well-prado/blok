/**
 * @packageDocumentation
 * @deprecated Prefer `@blokjs/core`. These primitives (Context, mapper,
 * NodeBase, error envelopes, …) are re-exported from `@blokjs/core/runtime`, so
 * a project only needs the one package (#374/#378). `@blokjs/shared` stays
 * published as a back-compat alias — existing imports keep working unchanged —
 * but new code should import from `@blokjs/core`.
 */
import BlokError, {
	type BlokErrorOpts,
	DEFAULT_HTTP_STATUS,
	DEFAULT_RETRYABLE,
	ErrorCategory,
	ErrorSeverity,
	isNonRetryableError,
	isNonRetryableStepError,
	isNonRetryableValidationError,
	markNonRetryableStepError,
	type NodeErrorPayload,
	WORKFLOW_INPUT_VALIDATION,
	WorkflowInputValidationError,
	type WorkflowInputValidationInfo,
	type WorkflowInputValidationIssue,
} from "./BlokError";
import {
	CAPABILITY_CLASSIFICATIONS,
	CAPABILITY_DETERMINISM,
	CAPABILITY_EFFECTS,
	CAPABILITY_IDEMPOTENCY,
	CAPABILITY_MANIFEST_VERSION,
	CAPABILITY_MATURITY,
	type CapabilityClassification,
	type CapabilityDeterminism,
	type CapabilityEffect,
	type CapabilityIdempotency,
	type CapabilityManifestAssessment,
	CapabilityManifestError,
	type CapabilityManifestStatus,
	type CapabilityManifestV1,
	type CapabilityMaturity,
	type CapabilityResourceBounds,
	assessCapabilityManifest,
	parseCapabilityManifest,
	requireAgentEligibleManifest,
	serializeCapabilityManifest,
} from "./CapabilityManifest";
import GlobalError from "./GlobalError";
import GlobalLogger from "./GlobalLogger";
import { Metrics, type MetricsType } from "./Metrics";
import NodeBase from "./NodeBase";
import Trigger from "./Trigger";
// These `types/*` modules are `type X = {...}; export default X;` — a type
// alias, not a runtime value (unlike `Trigger` above, a real class). Bun's
// per-file source loader (`bun -e import(...)`, in-monorepo scripts,
// bundler source-aliasing) can't see into the target file to know that; a
// plain value `import`/`export` of these names round-trips through a
// synthesized re-export that Bun rejects with "export default cannot be
// used with export *". `import type` here (and `type` on the corresponding
// `export { }` entries below) makes the type-only-ness explicit so no
// runtime binding is ever synthesized. See #702.
import type ConfigContext from "./types/ConfigContext";
import type ConnectionContext from "./types/ConnectionContext";
import type Context from "./types/Context";
import type EnvContext from "./types/EnvContext";
import type ErrorContext from "./types/ErrorContext";
import type FunctionContext from "./types/FunctionContext";
import type LoggerContext from "./types/LoggerContext";
import type NodeConfigContext from "./types/NodeConfigContext";
import type RequestContext from "./types/RequestContext";
import { RESPOND_BRAND, type RespondEnvelope, isRespondEnvelope } from "./types/RespondEnvelope";
import type ResponseContext from "./types/ResponseContext";
import type StateContext from "./types/StateContext";
import type Step from "./types/Step";
import type StreamContext from "./types/StreamContext";
import type VarsContext from "./types/VarsContext";
import mapper from "./utils/Mapper";
import { MapperResolutionError } from "./utils/MapperResolutionError";
import MemoryUsage from "./utils/MemoryUsage";
import { NamedMissingStateError } from "./utils/NamedMissingStateError";
import { type StructuralRef, type StructuralTpl, isStructuralRef, isStructuralTpl, lowerRefs } from "./utils/lowerRefs";
export type {
	AuditEventBase,
	AuditRedactionState,
	AuditSink,
	ExecutionOrigin,
	InteractionAttribution,
	InteractionRequest,
	InteractionSuspension,
	InteractionSuspensionPort,
	PolicyContext,
	PolicyDecision,
	PolicyDecisionKind,
	PolicyEvaluationResult,
	PolicyLayer,
	PolicyLayerName,
	PolicyProvider,
	PolicyRequest,
	PolicyRuleMatch,
	PostExecutionAuditEvent,
	PreExecutionAuditEvent,
	PrincipalIdentity,
	RequestedCapabilityScope,
	SandboxAttestation,
	SessionIdentity,
	StepIdentity,
	TurnIdentity,
	WorkflowIdentity,
} from "./PolicyContracts";
export type {
	AgentCompletionContract,
	AgentStepContract,
	ApprovalContract,
	AssertionGateContract,
	EvidenceGateContract,
	EvidenceGateRequirement,
	OutputTrust,
	TrustedEvidence,
} from "./EnforcementContracts";
export {
	ENFORCEMENT_CONTRACT_VERSION,
	EnforcementViolationError,
} from "./EnforcementContracts";
export type {
	SecretLease,
	SecretRef,
	SecretRequest,
	SecretResolutionAuditEvent,
	SecretResolutionFailure,
	SecretResolver,
} from "./SecretContracts";
export type {
	InteractionPayload,
	InteractionAnswer,
	InteractionRecord,
	InteractionStatus,
	InteractionStore,
} from "./InteractionContracts";
export type {
	ApprovalRequirement,
	ArtifactIdentity,
	ArtifactVersionIdentity,
	CompletionContract,
	CompletionRequirement,
	EvidenceArtifactIdentity,
	EvidenceCheck,
	EvidenceCheckOutcome,
	EvidenceKind,
	EvidencePayload,
	EvidenceProducerIdentity,
	EvidenceProducerKind,
	EvidenceProvenanceIdentity,
	EvidenceRecord,
	EvidenceRequirement,
	EvidenceVerificationMethod,
	EvidenceVerificationResult,
	EvidenceVerificationStatus,
	EvidenceVerifierIdentity,
	EvidenceVerifierKind,
} from "./EvidenceContracts";
export {
	ApprovalRequirementSchema,
	ArtifactIdentitySchema,
	ArtifactVersionIdentitySchema,
	CompletionContractSchema,
	CompletionRequirementSchema,
	EvidenceCheckSchema,
	EvidenceContractError,
	EvidenceProducerIdentitySchema,
	EvidenceProvenanceIdentitySchema,
	EvidenceRecordSchema,
	EvidenceRequirementSchema,
	EvidencePayloadSchema,
	EvidenceTraceIdentitySchema,
	EvidenceVerificationResultSchema,
	EvidenceVerifierIdentitySchema,
	EVIDENCE_CHECK_OUTCOMES,
	EVIDENCE_CONTRACT_VERSION,
	EVIDENCE_MAX_CHECKS,
	EVIDENCE_MAX_PAYLOAD_DEPTH,
	EVIDENCE_MAX_PAYLOAD_ITEMS,
	EVIDENCE_MAX_RECORD_BYTES,
	EVIDENCE_MAX_REQUIREMENTS,
	EVIDENCE_MAX_STRING_LENGTH,
	EVIDENCE_PRODUCER_KINDS,
	EVIDENCE_VERIFICATION_METHODS,
	EVIDENCE_VERIFICATION_STATUSES,
	EVIDENCE_VERIFIER_KINDS,
	parseCompletionContract,
	parseEvidencePayload,
	parseEvidenceRecord,
	rejectModelEvidence,
	serializeCompletionContract,
	serializeEvidenceRecord,
} from "./EvidenceContracts";
export {
	INTERACTION_MAX_LINEAGE_DEPTH,
	INTERACTION_MAX_LINEAGE_PATH,
	INTERACTION_MAX_PAYLOAD_BYTES,
	INTERACTION_MAX_PAYLOAD_DEPTH,
	INTERACTION_MAX_PAYLOAD_ITEMS,
	INTERACTION_MAX_STRING_LENGTH,
	INTERACTION_REDACTED_VALUE,
	INTERACTION_VERSION,
	InteractionContractError,
	fingerprintInteractionPayload,
	immutableInteractionSnapshot,
	parseInteractionAnswer,
	parseInteractionPayload,
	redactInteractionDecision,
	redactInteractionPayload,
	redactInteractionRequest,
	redactInteractionString,
} from "./InteractionContracts";

export {
	CAPABILITY_MANIFEST_VERSION,
	CAPABILITY_EFFECTS,
	CAPABILITY_CLASSIFICATIONS,
	CAPABILITY_DETERMINISM,
	CAPABILITY_IDEMPOTENCY,
	CAPABILITY_MATURITY,
	CapabilityManifestError,
	parseCapabilityManifest,
	serializeCapabilityManifest,
	assessCapabilityManifest,
	requireAgentEligibleManifest,
	type CapabilityEffect,
	type CapabilityClassification,
	type CapabilityDeterminism,
	type CapabilityIdempotency,
	type CapabilityMaturity,
	type CapabilityResourceBounds,
	type CapabilityManifestV1,
	type CapabilityManifestStatus,
	type CapabilityManifestAssessment,
	NodeBase,
	type Context,
	type RequestContext,
	type ResponseContext,
	RESPOND_BRAND,
	type RespondEnvelope,
	isRespondEnvelope,
	type EnvContext,
	type ErrorContext,
	type LoggerContext,
	type ConfigContext,
	type ConnectionContext,
	type StreamContext,
	Trigger,
	type NodeConfigContext,
	type FunctionContext,
	type StateContext,
	type VarsContext,
	type Step,
	GlobalLogger,
	GlobalError,
	BlokError,
	type BlokErrorOpts,
	type NodeErrorPayload,
	ErrorCategory,
	ErrorSeverity,
	DEFAULT_HTTP_STATUS,
	DEFAULT_RETRYABLE,
	isNonRetryableValidationError,
	// #679 — the ONE non-retryable matcher plus the marker the runner uses to
	// hand its verdict to the transports, so step-level and job-level retry can
	// never disagree.
	isNonRetryableError,
	markNonRetryableStepError,
	isNonRetryableStepError,
	WORKFLOW_INPUT_VALIDATION,
	WorkflowInputValidationError,
	type WorkflowInputValidationInfo,
	type WorkflowInputValidationIssue,
	Metrics,
	MemoryUsage,
	type MetricsType,
	mapper,
	MapperResolutionError,
	NamedMissingStateError,
	lowerRefs,
	// The lowering pass's OWN predicates — exported so the normalizer's
	// post-lowering total invariant (#707) tests the identical rule instead of
	// a second hand-written copy that could drift from what `lowerRefs` lowers.
	isStructuralRef,
	isStructuralTpl,
	type StructuralRef,
	type StructuralTpl,
};
