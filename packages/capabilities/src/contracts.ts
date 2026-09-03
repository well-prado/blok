import type {
	ArtifactVersionIdentity,
	CapabilityAuthority,
	EvidenceProvenanceIdentity,
	PolicyDecision,
	PolicyEvaluationResult,
	PolicyLayer,
	PolicyProvider,
	PolicyRequest,
	PrincipalIdentity,
	SessionIdentity,
	TurnIdentity,
	WorkflowIdentity,
} from "@blokjs/shared";

export const WORKSPACE_FILESYSTEM_CONTRACT_VERSION = "1" as const;
export const WORKSPACE_FILESYSTEM_OPERATIONS = [
	"metadata",
	"list",
	"read",
	"search",
	"write",
	"patch",
	"watch",
] as const;
export type WorkspaceFilesystemOperation = (typeof WORKSPACE_FILESYSTEM_OPERATIONS)[number];

export const WORKSPACE_FILESYSTEM_MAX_PATH_LENGTH = 4096;
export const WORKSPACE_FILESYSTEM_MAX_QUERY_LENGTH = 8192;
export const WORKSPACE_FILESYSTEM_MAX_READ_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_FILESYSTEM_MAX_WRITE_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_FILESYSTEM_MAX_LIST_FILES = 10_000;
export const WORKSPACE_FILESYSTEM_MAX_SEARCH_FILES = 2_000;
export const WORKSPACE_FILESYSTEM_MAX_SEARCH_MATCHES = 10_000;
export const WORKSPACE_FILESYSTEM_MAX_SEARCH_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_FILESYSTEM_MAX_LINES = 100_000;
export const WORKSPACE_FILESYSTEM_MAX_WATCH_EVENTS = 1_000;
export const WORKSPACE_FILESYSTEM_MAX_DURATION_MS = 30_000;
export const WORKSPACE_FILESYSTEM_MAX_WATCH_DEBOUNCE_MS = 5_000;

export type WorkspaceRootInput = {
	readonly id: string;
	readonly path: string;
};

export type WorkspaceRoot = {
	readonly id: string;
	/** Canonical host path. It is never returned in operation results. */
	readonly path: string;
};

export type WorkspaceFilesystemLimits = {
	readonly maxReadBytes?: number;
	readonly maxWriteBytes?: number;
	readonly maxListFiles?: number;
	readonly maxSearchFiles?: number;
	readonly maxSearchMatches?: number;
	readonly maxSearchBytes?: number;
	readonly maxLines?: number;
	readonly maxWatchEvents?: number;
	readonly maxDurationMs?: number;
};

export type WorkspaceFilesystemPolicyRequest = PolicyRequest & {
	readonly capability: "workspace-filesystem";
	readonly operation: WorkspaceFilesystemOperation;
	readonly workspaceId: string;
	/** Workspace-relative, canonical path. Host paths are never sent to policy. */
	readonly relativePath: string;
};

export type WorkspaceFilesystemPolicy = {
	readonly provider: PolicyProvider;
	readonly principal: PrincipalIdentity;
	readonly session: SessionIdentity;
	readonly turn: TurnIdentity;
	readonly policyVersion: string;
	readonly workflow: WorkflowIdentity;
	readonly step: { readonly id: string; readonly index?: number; readonly attempt?: number };
	readonly layers: readonly PolicyLayer[];
	readonly authority?: CapabilityAuthority;
};

export type WorkspaceFilesystemOptions = {
	readonly roots: readonly WorkspaceRootInput[];
	readonly limits?: WorkspaceFilesystemLimits;
	readonly policy?: WorkspaceFilesystemPolicy;
	readonly provenance?: EvidenceProvenanceIdentity;
};

export type WorkspacePathInput = {
	readonly workspaceId: string;
	/** Workspace-relative path. `/`, drive paths, UNC paths, and `..` are rejected. */
	readonly path: string;
	readonly signal?: AbortSignal;
	readonly maxDurationMs?: number;
};

export type WorkspaceFileKind = "file" | "directory";

export type WorkspaceArtifact = ArtifactVersionIdentity & {
	readonly workspaceId: string;
	readonly relativePath: string;
	readonly sizeBytes: number;
	readonly observedAt: string;
	readonly provenance?: EvidenceProvenanceIdentity;
};

export type WorkspaceFileMetadata = {
	readonly path: string;
	readonly kind: WorkspaceFileKind;
	readonly sizeBytes: number;
	readonly modifiedAt: string;
	readonly version?: string;
	readonly mediaType?: string;
	readonly artifact?: WorkspaceArtifact;
};

export type WorkspaceMetadataInput = WorkspacePathInput;

export type WorkspaceListInput = WorkspacePathInput & {
	readonly recursive?: boolean;
	readonly maxFiles?: number;
	readonly maxBytes?: number;
};

export type WorkspaceListResult = {
	readonly workspaceId: string;
	readonly path: string;
	readonly entries: readonly WorkspaceFileMetadata[];
	readonly bytesScanned: number;
	readonly truncated: boolean;
};

export type WorkspaceReadEncoding = "utf8" | "base64" | "bytes";
export type WorkspaceReadInput = WorkspacePathInput & {
	readonly encoding?: WorkspaceReadEncoding;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly maxBytes?: number;
	readonly maxLines?: number;
};

export type WorkspaceReadResult = {
	readonly workspaceId: string;
	readonly path: string;
	readonly encoding: WorkspaceReadEncoding;
	readonly bytes: Uint8Array;
	readonly content: string | Uint8Array;
	readonly sizeBytes: number;
	readonly version: string;
	readonly artifact: WorkspaceArtifact;
};

export type WorkspaceSearchInput = WorkspacePathInput & {
	readonly query: string;
	readonly regex?: boolean;
	readonly caseSensitive?: boolean;
	readonly maxFiles?: number;
	readonly maxMatches?: number;
	readonly maxBytes?: number;
	readonly maxLines?: number;
};

export type WorkspaceSearchMatch = {
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly text: string;
	readonly artifact?: WorkspaceArtifact;
};

export type WorkspaceSearchResult = {
	readonly workspaceId: string;
	readonly root: string;
	readonly matches: readonly WorkspaceSearchMatch[];
	readonly filesScanned: number;
	readonly bytesScanned: number;
	readonly truncated: boolean;
};

export type WorkspaceWriteInput = WorkspacePathInput & {
	readonly content: string | Uint8Array;
	/** Required when replacing an existing file. */
	readonly expectedVersion?: string;
	readonly maxBytes?: number;
};

export type WorkspaceWriteResult = {
	readonly workspaceId: string;
	readonly path: string;
	readonly created: boolean;
	readonly bytesWritten: number;
	readonly version: string;
	readonly artifact: WorkspaceArtifact;
};

export type WorkspaceTextPatch = {
	readonly start: number;
	readonly end: number;
	readonly replacement: string;
};

export type WorkspacePatchInput = WorkspacePathInput & {
	readonly patches: readonly WorkspaceTextPatch[];
	readonly expectedVersion: string;
	readonly maxBytes?: number;
};

export type WorkspaceWatchInput = WorkspacePathInput & {
	readonly recursive?: boolean;
	readonly debounceMs?: number;
	readonly maxEvents?: number;
};

export type WorkspaceWatchEvent = {
	readonly type: "created" | "changed" | "deleted" | "renamed" | "overflow";
	readonly workspaceId: string;
	readonly path?: string;
	readonly version?: string;
	readonly artifact?: WorkspaceArtifact;
	readonly requiresRescan: boolean;
	readonly observedAt: string;
};

export type WorkspacePolicyDecision = PolicyEvaluationResult & { readonly decision: PolicyDecision };
