import { z } from "zod";
import {
	AGENT_CAPABILITY_CONTRACT_VERSION,
	CAPABILITY_MAX_LIST_ITEMS,
	CapabilityContractError,
	CapabilityOwnerSchema,
	WorkspacePathRefSchema,
	assertAuthorized,
	assertOwned,
	capabilityScope,
	identifier,
	parseCapabilityOwner,
	parseWorkspacePathRef,
	timestamp,
	path as workspacePath,
} from "./CapabilityContracts";
import type { CapabilityOwner, CapabilityRequestContext, WorkspacePathRef } from "./CapabilityContracts";
import type { PolicyEvaluationResult, PolicyRequest } from "./PolicyContracts";
import type { RepositoryIdentity } from "./WorkflowBindingContracts";

export const GIT_CAPABILITY_CONTRACT_VERSION = AGENT_CAPABILITY_CONTRACT_VERSION;
export const GIT_MAX_CHANGED_FILES = 4_096;
export const GIT_MAX_BRANCH_NAME_LENGTH = 256;

export const GIT_OPERATIONS = [
	"repository.inspect",
	"worktree.create",
	"worktree.inspect",
	"worktree.diff",
	"worktree.cleanup",
] as const;
export type GitOperation = (typeof GIT_OPERATIONS)[number];

/** Deliberately not part of GitCapability: repository rewriting is denied. */
export const GIT_DESTRUCTIVE_OPERATIONS = [
	"repository.reset",
	"repository.clean",
	"repository.checkout",
	"repository.rebase",
	"repository.merge",
	"branch.delete",
	"worktree.force-cleanup",
] as const;
export type GitDestructiveOperation = (typeof GIT_DESTRUCTIVE_OPERATIONS)[number];

export type GitChangeStatus = "added" | "copied" | "deleted" | "modified" | "renamed" | "type-changed" | "untracked";
export type GitWorktreeStatus = "active" | "cleanup-pending" | "cleaned";

export interface GitRevisionIdentity {
	readonly commit: string;
	readonly ref?: string;
}

export interface GitDirtyState {
	readonly status: "clean" | "dirty";
	/** Hash of the status/content identity observed at the boundary. */
	readonly fingerprint: string;
	readonly changedPaths: readonly string[];
}

/** Repository facts captured before a task starts. */
export interface GitRepositoryIdentity {
	readonly repository: RepositoryIdentity;
	readonly checkout: WorkspacePathRef;
	readonly head: GitRevisionIdentity;
	readonly dirty: GitDirtyState;
	readonly owner: CapabilityOwner;
}

export interface GitWorktreeCreateRequest extends CapabilityRequestContext {
	readonly policy: PolicyRequest;
	readonly repository: GitRepositoryIdentity;
	readonly base: GitRevisionIdentity;
	readonly branch: string;
	readonly path?: WorkspacePathRef;
	/** Required so a dirty primary checkout can never be discarded implicitly. */
	readonly preserveSourceChanges: true;
}

export interface GitWorktreeCleanupRequest extends GitCapabilityRequest {
	/** Cleanup may not discard task changes; dirty worktrees stay recoverable. */
	readonly preserveChanges: true;
	readonly worktree: GitWorktreeIdentity;
}

export interface GitWorktreeIdentity {
	readonly version: typeof GIT_CAPABILITY_CONTRACT_VERSION;
	readonly id: string;
	readonly repository: GitRepositoryIdentity;
	readonly path: WorkspacePathRef;
	readonly branch: string;
	readonly base: GitRevisionIdentity;
	readonly head: GitRevisionIdentity;
	readonly sourceDirty: GitDirtyState;
	readonly owner: CapabilityOwner;
	readonly status: GitWorktreeStatus;
	readonly createdAt: string;
	readonly cleanedAt?: string;
}

export interface GitDiffFile {
	readonly path: string;
	readonly status: GitChangeStatus;
	readonly previousPath?: string;
	readonly contentHash: string;
	readonly sizeBytes?: number;
}

export interface GitDiffEvidence {
	readonly version: typeof GIT_CAPABILITY_CONTRACT_VERSION;
	readonly repository: RepositoryIdentity;
	readonly worktree: GitWorktreeIdentity;
	readonly base: GitRevisionIdentity;
	readonly head: GitRevisionIdentity;
	readonly dirty: GitDirtyState;
	readonly files: readonly GitDiffFile[];
	/** Hash of the canonical diff/evidence record, not an unverified claim. */
	readonly evidenceHash: string;
	readonly capturedAt: string;
}

export interface GitCapabilityRequest extends CapabilityRequestContext {
	readonly policy: PolicyRequest;
	readonly operation: GitOperation;
	readonly repository: GitRepositoryIdentity;
	readonly worktree?: GitWorktreeIdentity;
}

export interface GitCapability {
	inspectRepository(request: GitCapabilityRequest): Promise<GitRepositoryIdentity>;
	createWorktree(request: GitWorktreeCreateRequest): Promise<GitWorktreeIdentity>;
	inspectWorktree(request: GitCapabilityRequest): Promise<GitWorktreeIdentity>;
	diff(request: GitCapabilityRequest): Promise<GitDiffEvidence>;
	cleanup(request: GitWorktreeCleanupRequest): Promise<GitWorktreeIdentity>;
}

const revisionSchema = z.object({
	commit: z
		.string()
		.regex(/^[0-9a-f]{7,64}$/i)
		.transform((value) => value.toLowerCase()),
	ref: identifier.optional(),
});
const dirtyStateSchema = z
	.object({
		status: z.enum(["clean", "dirty"]),
		fingerprint: z
			.string()
			.regex(/^(?:sha256):[0-9a-f]{64}$|^(?:sha512):[0-9a-f]{128}$/i)
			.transform((value) => value.toLowerCase()),
		changedPaths: z.array(workspacePath).max(CAPABILITY_MAX_LIST_ITEMS),
	})
	.superRefine((value, context) => {
		if (value.status === "dirty" && value.changedPaths.length === 0)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["changedPaths"],
				message: "dirty state must identify changed paths",
			});
		if (value.status === "clean" && value.changedPaths.length > 0)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["changedPaths"],
				message: "clean state cannot identify changed paths",
			});
	});
const repositorySchema = z.object({
	repository: z.object({ provider: identifier, id: identifier, revision: z.string().max(256).optional() }),
	checkout: WorkspacePathRefSchema,
	head: revisionSchema,
	dirty: dirtyStateSchema,
	owner: CapabilityOwnerSchema,
});
const worktreeSchema = z
	.object({
		version: z.literal(GIT_CAPABILITY_CONTRACT_VERSION),
		id: identifier,
		repository: repositorySchema,
		path: WorkspacePathRefSchema,
		branch: z
			.string()
			.min(1)
			.max(GIT_MAX_BRANCH_NAME_LENGTH)
			.regex(/^[A-Za-z0-9._/-]+$/),
		base: revisionSchema,
		head: revisionSchema,
		sourceDirty: dirtyStateSchema,
		owner: CapabilityOwnerSchema,
		status: z.enum(["active", "cleanup-pending", "cleaned"]),
		createdAt: timestamp,
		cleanedAt: timestamp.optional(),
	})
	.superRefine((value, context) => {
		if (value.status === "cleaned" && value.cleanedAt === undefined)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["cleanedAt"],
				message: "cleaned worktree must record cleanedAt",
			});
		if (value.status !== "cleaned" && value.cleanedAt !== undefined)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["cleanedAt"],
				message: "active worktree cannot record cleanedAt",
			});
	});
const diffFileSchema = z.object({
	path: workspacePath,
	status: z.enum(["added", "copied", "deleted", "modified", "renamed", "type-changed", "untracked"]),
	previousPath: workspacePath.optional(),
	contentHash: z
		.string()
		.regex(/^(?:sha256):[0-9a-f]{64}$|^(?:sha512):[0-9a-f]{128}$/i)
		.transform((value) => value.toLowerCase()),
	sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
const diffEvidenceSchema = z
	.object({
		version: z.literal(GIT_CAPABILITY_CONTRACT_VERSION),
		repository: z.object({ provider: identifier, id: identifier, revision: z.string().max(256).optional() }),
		worktree: worktreeSchema,
		base: revisionSchema,
		head: revisionSchema,
		dirty: dirtyStateSchema,
		files: z.array(diffFileSchema).max(GIT_MAX_CHANGED_FILES),
		evidenceHash: z
			.string()
			.regex(/^(?:sha256):[0-9a-f]{64}$|^(?:sha512):[0-9a-f]{128}$/i)
			.transform((value) => value.toLowerCase()),
		capturedAt: timestamp,
	})
	.superRefine((value, context) => {
		if (
			value.repository.provider !== value.worktree.repository.repository.provider ||
			value.repository.id !== value.worktree.repository.repository.id
		)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["repository"],
				message: "must match worktree repository identity",
			});
		if (value.base.commit !== value.worktree.base.commit)
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["base"], message: "must match worktree base revision" });
		if (value.head.commit !== value.worktree.head.commit)
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["head"], message: "must match worktree head revision" });
		if (value.dirty.fingerprint !== value.worktree.sourceDirty.fingerprint)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["dirty"],
				message: "must match worktree source dirty identity",
			});
	});

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const result = schema.safeParse(value);
	if (!result.success)
		throw new CapabilityContractError(`${label}: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
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

export function parseGitDirtyState(value: unknown): GitDirtyState {
	const parsed = parse(dirtyStateSchema, value, "git dirty state");
	return immutable({ ...parsed, changedPaths: [...new Set(parsed.changedPaths)].sort() });
}

export function parseGitRepositoryIdentity(value: unknown): GitRepositoryIdentity {
	const parsed = parse(repositorySchema, value, "git repository identity");
	return immutable({ ...parsed, dirty: parseGitDirtyState(parsed.dirty) });
}

export function parseGitWorktreeIdentity(value: unknown): GitWorktreeIdentity {
	const parsed = parse(worktreeSchema, value, "git worktree identity");
	return immutable({
		...parsed,
		repository: { ...parsed.repository, dirty: parseGitDirtyState(parsed.repository.dirty) },
		sourceDirty: parseGitDirtyState(parsed.sourceDirty),
	});
}

export function parseGitDiffEvidence(value: unknown): GitDiffEvidence {
	const parsed = parse(diffEvidenceSchema, value, "git diff evidence");
	return immutable({
		...parsed,
		dirty: parseGitDirtyState(parsed.dirty),
		worktree: parseGitWorktreeIdentity(parsed.worktree),
	});
}

export function parseGitWorktreeCreateRequest(value: unknown): GitWorktreeCreateRequest {
	const schema = z.object({
		policy: z.custom<PolicyRequest>(),
		owner: CapabilityOwnerSchema,
		repository: repositorySchema,
		base: revisionSchema,
		branch: z
			.string()
			.min(1)
			.max(GIT_MAX_BRANCH_NAME_LENGTH)
			.regex(/^[A-Za-z0-9._/-]+$/),
		path: WorkspacePathRefSchema.optional(),
		preserveSourceChanges: z.literal(true),
	});
	const parsed = parse(schema, value, "git worktree create request");
	return immutable({ ...parsed, repository: parseGitRepositoryIdentity(parsed.repository) });
}

export function gitCapabilityScope(operation: GitOperation): ReturnType<typeof capabilityScope> {
	if (operation === "worktree.create" || operation === "worktree.cleanup")
		return capabilityScope(["read", "write"], [`git.${operation}`]);
	return capabilityScope(["read"], [`git.${operation}`]);
}

export function assertGitOperationAllowed(operation: string): asserts operation is GitOperation {
	if ((GIT_OPERATIONS as readonly string[]).includes(operation)) return;
	if ((GIT_DESTRUCTIVE_OPERATIONS as readonly string[]).includes(operation))
		throw new CapabilityContractError(`destructive git operation is denied: ${operation}`);
	throw new CapabilityContractError(`unsupported git operation: ${operation}`);
}

export function parseGitOperation(value: unknown): GitOperation {
	if (typeof value !== "string") throw new CapabilityContractError("git operation must be a string");
	assertGitOperationAllowed(value);
	return value;
}

export function assertGitPolicyAllowed(result: PolicyEvaluationResult): void {
	assertAuthorized(result, { allowSandbox: true });
}

export function assertGitOwner(repository: GitRepositoryIdentity, owner: CapabilityOwner): void {
	assertOwned(repository.owner, parseCapabilityOwner(owner));
}

export function workspacePathForGit(value: unknown): WorkspacePathRef {
	return parseWorkspacePathRef(value);
}
