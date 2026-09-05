import { z } from "zod";
import type { PolicyContext, PolicyDecision, PolicyEvaluationResult, PolicyProvider } from "./PolicyContracts";
import type { PrincipalIdentity, RequestedCapabilityScope } from "./PolicyContracts";

/** Version shared by the H3 capability contracts. */
export const AGENT_CAPABILITY_CONTRACT_VERSION = "1" as const;

export const CAPABILITY_MAX_ID_LENGTH = 128;
export const CAPABILITY_MAX_PATH_LENGTH = 4_096;
export const CAPABILITY_MAX_LIST_ITEMS = 1_024;
export const CAPABILITY_MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;

export interface CapabilityOwner {
	readonly principal: PrincipalIdentity;
	readonly sessionId: string;
	readonly turnId?: string;
	readonly taskId: string;
}

/**
 * An opaque reference into the workspace capability (#927). H3 contracts do
 * not canonicalize paths or access the host filesystem; the filesystem
 * capability owns that boundary.
 */
export interface WorkspacePathRef {
	readonly workspaceId: string;
	readonly path: string;
}

export interface CapabilityRequestContext {
	readonly policy: PolicyContext;
	readonly owner: CapabilityOwner;
}

/** Every trusted adapter must authorize before doing host-side work. */
export interface CapabilityAuthorizationPort {
	authorize(request: PolicyContext): Promise<PolicyEvaluationResult>;
	readonly provider?: PolicyProvider;
}

export class CapabilityContractError extends Error {
	readonly code = "CAPABILITY_CONTRACT_INVALID";

	constructor(message: string) {
		super(message);
		this.name = "CapabilityContractError";
	}
}

const identifier = z
	.string()
	.min(1)
	.max(CAPABILITY_MAX_ID_LENGTH)
	.regex(/^[A-Za-z][A-Za-z0-9._:/-]*$/);
const path = z
	.string()
	.min(1)
	.max(CAPABILITY_MAX_PATH_LENGTH)
	.refine((value) => !value.includes("\0"), "must not contain NUL")
	.refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value), "must be workspace-relative")
	.refine((value) => !value.split(/[\\/]+/).includes(".."), "must not escape the workspace");
const timestamp = z.string().refine((value) => {
	if (!Number.isFinite(Date.parse(value))) return false;
	return new Date(value).toISOString() === value;
}, "must be a canonical ISO timestamp");
const sessionId = z.string().min(1).max(CAPABILITY_MAX_ID_LENGTH);
const digest = z
	.string()
	.regex(/^(?:sha256):[0-9a-f]{64}$|^(?:sha512):[0-9a-f]{128}$/i)
	.transform((value) => value.toLowerCase());
const ownerSchema = z.object({
	principal: z.object({ id: identifier, kind: identifier }),
	// Session IDs are opaque references and the control plane uses UUIDs.
	sessionId,
	turnId: identifier.optional(),
	taskId: identifier,
});
const workspacePathSchema = z.object({ workspaceId: identifier, path });

export const CapabilityOwnerSchema = ownerSchema;
export const WorkspacePathRefSchema = workspacePathSchema;

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new CapabilityContractError(
			result.error.issues
				.map((issue) => `${label}${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""} ${issue.message}`)
				.join("; "),
		);
	}
	return result.data;
}

function immutable<T>(value: T): T {
	const snapshot = structuredClone(value);
	const freeze = (item: unknown): void => {
		if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
		for (const child of Object.values(item)) freeze(child);
		Object.freeze(item);
	};
	freeze(snapshot);
	return snapshot;
}

export function parseCapabilityOwner(value: unknown): CapabilityOwner {
	return immutable(parse(ownerSchema, value, "capability owner"));
}

export function parseWorkspacePathRef(value: unknown): WorkspacePathRef {
	return immutable(parse(workspacePathSchema, value, "workspace path"));
}

export function parseCapabilityAuthorization(
	decision: PolicyDecision,
	result?: PolicyEvaluationResult,
): PolicyEvaluationResult {
	if (!result || result.decision.id !== decision.id) {
		throw new CapabilityContractError("authorization result does not match the policy decision");
	}
	return result;
}

export function assertAuthorized(result: PolicyEvaluationResult, options: { allowSandbox?: boolean } = {}): void {
	if (result.decision.kind === "allow") return;
	if (options.allowSandbox && result.decision.kind === "require-sandbox" && result.sandbox?.proof) return;
	throw new CapabilityContractError(`capability execution is not authorized: ${result.decision.kind}`);
}

export function assertOwned(owner: CapabilityOwner, expected: CapabilityOwner): void {
	if (
		owner.principal.id !== expected.principal.id ||
		owner.principal.kind !== expected.principal.kind ||
		owner.sessionId !== expected.sessionId ||
		owner.taskId !== expected.taskId ||
		(owner.turnId ?? "") !== (expected.turnId ?? "")
	) {
		throw new CapabilityContractError("capability handle is owned by a different task context");
	}
}

export function capabilityScope(
	effects: RequestedCapabilityScope["effects"],
	capabilities: readonly string[],
	secrets: readonly string[] = [],
): RequestedCapabilityScope {
	return {
		effects: [...new Set(effects)].sort(),
		capabilities: [...new Set(capabilities)].sort(),
		secrets: [...new Set(secrets)].sort(),
		fragments: {},
	};
}

export { digest, identifier, path, timestamp };
