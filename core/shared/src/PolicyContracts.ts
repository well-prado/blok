import type { CapabilityEffect, CapabilityManifestV1 } from "./CapabilityManifest";

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
	readonly workflow: WorkflowIdentity;
	readonly step: StepIdentity;
	readonly manifest: CapabilityManifestV1 | null;
	readonly scope: RequestedCapabilityScope;
	readonly layers: readonly PolicyLayer[];
	readonly signal?: AbortSignal;
}
export interface PolicyRequest extends PolicyContext {
	readonly requestId: string;
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
	append(event: PreExecutionAuditEvent | PostExecutionAuditEvent): Promise<void>;
}
export interface InteractionRequest {
	readonly id: string;
	readonly decision: PolicyDecision;
	readonly request: PolicyRequest;
}
export interface InteractionSuspensionPort {
	suspend(request: InteractionRequest): Promise<void>;
}
