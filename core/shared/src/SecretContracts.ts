import type { InteractionAttribution, PolicyContext } from "./PolicyContracts";

export const SECRET_REFERENCE_VERSION = "1" as const;

/** An opaque name, never a credential or resolved value. */
export interface SecretRef {
	readonly version: typeof SECRET_REFERENCE_VERSION;
	readonly name: string;
}

export interface SecretRequest extends PolicyContext {
	readonly reference: SecretRef;
	readonly requestId: string;
}

/** A deliberately non-serializable capability for trusted node code. */
export interface SecretLease {
	readonly reference: SecretRef;
	readonly leaseId: string;
	readonly expiresAt: string;
	readonly read: () => string;
}

export interface SecretResolver {
	resolve(request: SecretRequest): Promise<SecretLease>;
}

export type SecretResolutionFailure =
	| "SECRET_NOT_AUTHORIZED"
	| "SECRET_NOT_FOUND"
	| "SECRET_EXPIRED"
	| "SECRET_REVOKED"
	| "SECRET_RESOLVER_UNAVAILABLE";

export interface SecretResolutionAuditEvent {
	readonly version: "1";
	readonly eventType: "secret.resolve";
	readonly eventId: string;
	readonly timestamp: string;
	readonly correlationId: string;
	readonly principalId?: string;
	readonly sessionId?: string;
	readonly turnId?: string;
	readonly attribution?: InteractionAttribution;
	readonly workflow: PolicyContext["workflow"];
	readonly step: PolicyContext["step"];
	readonly reference: SecretRef;
	readonly leaseId?: string;
	readonly outcome: "success" | "failure";
	readonly errorCode?: SecretResolutionFailure;
	readonly redaction: {
		readonly redacted: true;
		readonly fields: readonly ["value"];
	};
}
