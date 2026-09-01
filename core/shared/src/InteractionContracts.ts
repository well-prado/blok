import type { PolicyDecision, PolicyRequest } from "./PolicyContracts";

export const INTERACTION_VERSION = "1" as const;
export type InteractionStatus = "pending" | "answered" | "denied" | "expired" | "cancelled";

export interface InteractionRecord {
	readonly version: typeof INTERACTION_VERSION;
	readonly id: string;
	readonly request: PolicyRequest;
	readonly decision: PolicyDecision;
	readonly status: InteractionStatus;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly sequence: number;
	readonly answer?: unknown;
	readonly answeredBy?: string;
	readonly answeredAt?: string;
	/** Set when the answered record is atomically claimed for resumption. */
	readonly claimedBy?: string;
	readonly claimedAt?: string;
}

export interface InteractionAnswer {
	readonly id: string;
	readonly principalId: string;
	readonly answer?: unknown;
	readonly deny?: boolean;
	readonly sequence: number;
}

export interface InteractionStore {
	create(request: PolicyRequest, decision: PolicyDecision, opts?: { expiresAt?: string }): Promise<InteractionRecord>;
	get(id: string): Promise<InteractionRecord | undefined>;
	answer(answer: InteractionAnswer): Promise<InteractionRecord>;
	/**
	 * Atomically consume an answered interaction for one resume attempt.
	 * Implementations must compare both the principal and expected sequence
	 * in the same transaction as the claim.
	 */
	claim(id: string, principalId: string, sequence: number): Promise<InteractionRecord>;
	cancel(id: string, principalId: string, sequence: number): Promise<InteractionRecord>;
	expire(now?: string): Promise<readonly InteractionRecord[]>;
}
