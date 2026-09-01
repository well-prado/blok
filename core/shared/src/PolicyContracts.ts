import type { CapabilityEffect, CapabilityManifestV1 } from "./CapabilityManifest";
import type { ApprovalContract } from "./EnforcementContracts";

export type ExecutionOrigin = "ordinary" | "agent";

export interface PrincipalIdentity {
	readonly id: string;
	readonly kind: string;
}
export interface SessionIdentity {
	readonly id: string;
}
export interface TurnIdentity {
	readonly id: string;
	readonly index?: number;
}
/**
 * Bounded lineage for policy and interaction records.
 *
 * The runner may execute a policy request from a nested workflow or a
 * parallel branch. Keeping this metadata on the request means a control-plane
 * consumer can attribute an answer without inferring ownership from a step
 * name (which is only unique within one workflow definition).
 */
export interface InteractionAttribution {
	/** Stable root execution/session lineage identifier. */
	readonly rootId: string;
	/** Parent run, workflow, or interaction identifier when nested. */
	readonly parentId?: string;
	/** Stable branch/child identifier for parallel or delegated work. */
	readonly branchId?: string;
	/** Zero-based branch position, when the parent fan-out has an index. */
	readonly branchIndex?: number;
	/** Ordered, bounded path of nested workflow/branch labels. */
	readonly branchPath?: readonly string[];
	/** Nesting depth; root executions use zero. */
	readonly depth: number;
}
export interface WorkflowIdentity {
	readonly name: string;
	readonly version?: string;
}
export interface StepIdentity {
	readonly id: string;
	readonly index?: number;
	readonly attempt?: number;
}

export interface RequestedCapabilityScope {
	readonly effects: readonly CapabilityEffect[];
	readonly capabilities: readonly string[];
	readonly secrets: readonly string[];
	readonly fragments: Readonly<Record<string, string | number | boolean>>;
}

export type PolicyLayerName = "deployment" | "repository" | "workflow" | "phase" | "user";
export interface PolicyLayer {
	readonly name: PolicyLayerName;
	readonly version: string;
}
export interface PolicyRuleMatch {
	readonly layer: PolicyLayerName;
	readonly ruleId: string;
	readonly effect?: "allow" | "deny" | "ask" | "require-sandbox";
}
export type PolicyDecisionKind = "allow" | "deny" | "ask" | "require-sandbox";
export interface PolicyDecision {
	readonly kind: PolicyDecisionKind;
	readonly id: string;
	readonly reasonCode: string;
	readonly reason?: string;
	readonly policyVersion: string;
}

export interface SandboxAttestation {
	readonly id: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly principalId: string;
	readonly sessionId: string;
	readonly workflow: WorkflowIdentity;
	readonly step: StepIdentity;
	readonly effects: readonly CapabilityEffect[];
	readonly profile: string;
	readonly policyDecisionId: string;
	readonly proof: string;
}

export interface PolicyContext {
	readonly origin: ExecutionOrigin;
	readonly principal?: PrincipalIdentity;
	readonly session?: SessionIdentity;
	readonly turn?: TurnIdentity;
	readonly attribution?: InteractionAttribution;
	readonly workflow: WorkflowIdentity;
	readonly step: StepIdentity;
	readonly manifest: CapabilityManifestV1 | null;
	readonly scope: RequestedCapabilityScope;
	readonly layers: readonly PolicyLayer[];
	readonly signal?: AbortSignal;
	/** Explicit approval handoff requested by an H1-02 approval step. */
	readonly approval?: ApprovalContract;
}
export interface PolicyRequest extends PolicyContext {
	readonly requestId: string;
	/** Durable execution reference when this request is an interaction ask. */
	readonly suspension?: InteractionSuspension;
}
export interface PolicyEvaluationResult {
	readonly decision: PolicyDecision;
	readonly matchedRules: readonly PolicyRuleMatch[];
	readonly sandbox?: SandboxAttestation;
}

export interface AuditRedactionState {
	readonly redacted: boolean;
	readonly truncated: boolean;
	readonly fields: readonly string[];
}
export interface AuditEventBase {
	readonly version: "1";
	readonly eventType: "policy.pre" | "policy.post";
	readonly eventId: string;
	readonly timestamp: string;
	readonly correlationId: string;
	readonly decisionId: string;
	readonly principalId?: string;
	readonly sessionId?: string;
	readonly turnId?: string;
	readonly workflow: WorkflowIdentity;
	readonly step: StepIdentity;
	readonly attempt: number;
	readonly runtime?: string;
	readonly transport?: string;
	readonly manifest: CapabilityManifestV1 | null;
	readonly scope: RequestedCapabilityScope;
	readonly layers: readonly PolicyLayer[];
	readonly matchedRules: readonly PolicyRuleMatch[];
	readonly decision: PolicyDecision;
	readonly attribution?: InteractionAttribution;
	readonly sandbox: { required: boolean; verified: boolean };
	readonly cached: boolean;
	readonly redaction: AuditRedactionState;
}
export interface PreExecutionAuditEvent extends AuditEventBase {
	readonly eventType: "policy.pre";
}
export interface PostExecutionAuditEvent extends AuditEventBase {
	readonly eventType: "policy.post";
	readonly durationMs: number;
	readonly outcome: "success" | "failure" | "cancelled";
	readonly errorCode?: string;
}

export interface PolicyProvider {
	evaluate(request: PolicyRequest): Promise<PolicyEvaluationResult>;
}
export interface AuditSink {
	append(
		event: PreExecutionAuditEvent | PostExecutionAuditEvent | import("./SecretContracts").SecretResolutionAuditEvent,
	): Promise<void>;
}
export interface InteractionRequest {
	readonly id: string;
	readonly decision: PolicyDecision;
	readonly request: PolicyRequest;
	/**
	 * Durable run identity used by the control plane to resume the existing
	 * execution. This is a reference to persisted trace state, not a copy of
	 * workflow data or secrets.
	 */
	readonly suspension?: InteractionSuspension;
}

export interface InteractionSuspension {
	readonly runId: string;
	readonly status: "suspended";
	readonly step: StepIdentity;
	readonly cursor: {
		readonly stepIndex: number;
		readonly deep: boolean;
		readonly nodeRunId?: string;
		readonly lastCompletedStepIndex?: number;
	};
	readonly trace: {
		readonly workflow: WorkflowIdentity;
		readonly parentRunId?: string;
		readonly parentNodeRunId?: string;
	};
}
export interface InteractionSuspensionPort {
	suspend(request: InteractionRequest): Promise<void>;
}
