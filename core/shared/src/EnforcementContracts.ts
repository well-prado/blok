/**
 * H1-02 contracts shared by authoring, the runner, and control-plane adapters.
 *
 * These are deliberately data-only. A model can return data that resembles a
 * trusted record, but the runner decides whether the producing step is allowed
 * to establish trusted provenance.
 */

export const ENFORCEMENT_CONTRACT_VERSION = "1" as const;

export type OutputTrust = "model" | "trusted";

export interface AgentCompletionContract {
	readonly required?: boolean;
	/** Dot-separated output path; defaults to `completed`. */
	readonly path?: string;
	/** Expected value at `path`; defaults to `true`. */
	readonly equals?: unknown;
}

export interface AgentStepContract {
	readonly version: typeof ENFORCEMENT_CONTRACT_VERSION;
	readonly objective: string;
	readonly completion: AgentCompletionContract;
}

export interface ApprovalContract {
	readonly version: typeof ENFORCEMENT_CONTRACT_VERSION;
	readonly reason: string;
	readonly scope?: string;
}

export interface AssertionGateContract {
	readonly version: typeof ENFORCEMENT_CONTRACT_VERSION;
	readonly path?: string;
	readonly equals?: unknown;
	readonly truthy?: boolean;
	readonly message?: string;
}

export interface EvidenceRequirement {
	readonly artifactId: string;
	readonly artifactVersion: string;
	readonly producerStepId: string;
}

export interface EvidenceGateContract {
	readonly version: typeof ENFORCEMENT_CONTRACT_VERSION;
	readonly requirements: readonly EvidenceRequirement[];
}

export interface TrustedEvidence {
	readonly version: typeof ENFORCEMENT_CONTRACT_VERSION;
	readonly provenance: "trusted";
	readonly producer: {
		readonly stepId: string;
		readonly workflow: string;
	};
	readonly artifact: {
		readonly id: string;
		readonly version: string;
	};
	readonly verified: true;
	readonly verification?: string;
}

export class EnforcementViolationError extends Error {
	readonly code = "ENFORCEMENT_REJECTED";

	constructor(
		public readonly reasonCode: string,
		message: string,
	) {
		super(message);
		this.name = "EnforcementViolationError";
	}
}
