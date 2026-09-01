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
	cancel(id: string, principalId: string, sequence: number): Promise<InteractionRecord>;
	expire(now?: string): Promise<readonly InteractionRecord[]>;
}
