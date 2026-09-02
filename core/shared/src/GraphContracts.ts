import { z } from "zod";
import type { RepositoryIdentity } from "./WorkflowBindingContracts";

/** Version of the provider-neutral graph contract. */
export const GRAPH_CONTRACT_VERSION = "1" as const;

export const GRAPH_RESULT_STATES = [
	"fresh",
	"stale",
	"missing",
	"truncated",
	"partial",
	"unsupported",
	"conflict",
] as const;
export const GRAPH_FRESHNESS_STATES = ["fresh", "stale", "unknown"] as const;
export const GRAPH_RELATION_KINDS = [
	"defines",
	"contains",
	"calls",
	"imports",
	"exports",
	"references",
	"extends",
	"implements",
	"overrides",
	"tests",
] as const;
export const GRAPH_SYMBOL_KINDS = [
	"file",
	"module",
	"namespace",
	"class",
	"interface",
	"enum",
	"function",
	"method",
	"property",
	"variable",
	"type",
	"unknown",
] as const;
export const GRAPH_SEARCH_KINDS = ["symbol", "file", "module", "text"] as const;
export const GRAPH_INDEX_SOURCES = ["authoritative", "uncommitted-overlay", "provider"] as const;
export const GRAPH_RELATION_DIRECTIONS = ["inbound", "outbound", "both"] as const;

export const GRAPH_MAX_STRING_LENGTH = 512;
export const GRAPH_MAX_PATH_LENGTH = 1024;
export const GRAPH_MAX_ITEMS = 500;
export const GRAPH_MAX_FILES_PER_INDEX = 500;
export const GRAPH_MAX_INDEX_BYTES = 16 * 1024 * 1024;
export const GRAPH_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const GRAPH_MAX_DEPTH = 32;

export type GraphResultState = (typeof GRAPH_RESULT_STATES)[number];
export type GraphFreshnessState = (typeof GRAPH_FRESHNESS_STATES)[number];
export type GraphRelationKind = (typeof GRAPH_RELATION_KINDS)[number];
export type GraphSymbolKind = (typeof GRAPH_SYMBOL_KINDS)[number];
export type GraphSearchKind = (typeof GRAPH_SEARCH_KINDS)[number];
export type GraphIndexSource = (typeof GRAPH_INDEX_SOURCES)[number];
export type GraphRelationDirection = (typeof GRAPH_RELATION_DIRECTIONS)[number];

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const PATH = /^[^\0]{1,1024}$/;
const DIGEST = /^(sha256):[0-9a-f]{64}$|^(sha512):[0-9a-f]{128}$/i;
const identifier = z.string().min(1).max(128).regex(IDENTIFIER, "must be a bounded identifier");
const boundedString = z.string().min(1).max(GRAPH_MAX_STRING_LENGTH);
const path = z.string().min(1).max(GRAPH_MAX_PATH_LENGTH).regex(PATH, "must be a bounded path");
const digest = z
	.string()
	.max(140)
	.regex(DIGEST, "must be a sha256: or sha512: digest with the complete hexadecimal length")
	.transform((value) => value.toLowerCase());
const timestamp = z.string().min(1).max(64);

/** Graph scope reuses the provider-neutral repository identity from bindings. */
export type GraphRepositoryIdentity = RepositoryIdentity;

export interface GraphWorktreeIdentity {
	readonly id: string;
	readonly branch?: string;
	readonly commit?: string;
	readonly dirty?: boolean;
	readonly overlay?: "clean" | "uncommitted" | "unknown";
}

export interface GraphScope {
	readonly repository: GraphRepositoryIdentity;
	readonly worktree?: GraphWorktreeIdentity;
	readonly commit?: string;
	/** Known current hashes keyed by normalized repository-relative path. */
	readonly contentHashes?: Readonly<Record<string, string>>;
}

export interface GraphRange {
	readonly start: { readonly line: number; readonly column?: number };
	readonly end?: { readonly line: number; readonly column?: number };
}

export interface GraphLocation {
	readonly path: string;
	readonly range?: GraphRange;
	readonly language?: string;
	readonly contentHash?: string;
}

/** Evidence that a response came from a particular derived index. */
export interface GraphProvenance {
	readonly source: "derived-index";
	readonly provider: string;
	readonly providerVersion?: string;
	readonly indexVersion: string;
	readonly repository: GraphRepositoryIdentity;
	readonly worktree?: GraphWorktreeIdentity;
	readonly commit?: string;
	readonly contentHash?: string;
	readonly path?: string;
	readonly range?: GraphRange;
	readonly indexedAt?: string;
}

export interface GraphFreshness {
	readonly state: GraphFreshnessState;
	readonly indexedAt?: string;
	readonly checkedAt: string;
	readonly indexedCommit?: string;
	readonly observedCommit?: string;
	readonly indexedContentHash?: string;
	readonly observedContentHash?: string;
	readonly reason?: string;
}

export interface GraphResultStatus {
	readonly primary: GraphResultState;
	/** Multiple states are allowed, for example stale + truncated. */
	readonly states: readonly GraphResultState[];
	readonly complete: boolean;
}

export type GraphErrorCategory =
	| "provider-unavailable"
	| "invalid-query"
	| "not-found"
	| "unsupported"
	| "stale"
	| "conflict"
	| "limit-exceeded"
	| "cancelled"
	| "index-failed"
	| "internal";

export interface GraphError {
	readonly code: string;
	readonly category: GraphErrorCategory;
	readonly message: string;
	readonly retryable: boolean;
	readonly guidance: "reread-authoritative-source" | "retry" | "narrow-query" | "inspect-provider" | "none";
	readonly path?: string;
}

export interface GraphSymbol {
	readonly id: string;
	readonly name: string;
	readonly kind: GraphSymbolKind;
	readonly location: GraphLocation;
	readonly language?: string;
	readonly signature?: string;
	readonly containerId?: string;
	readonly exported?: boolean;
}

export interface GraphRelation {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly kind: GraphRelationKind;
	readonly location?: GraphLocation;
}

export interface GraphSearchHit {
	readonly id: string;
	readonly kind: GraphSearchKind;
	readonly name: string;
	readonly score: number;
	readonly symbol?: GraphSymbol;
	readonly location?: GraphLocation;
}

export interface GraphQueryResponse<T> {
	readonly version: typeof GRAPH_CONTRACT_VERSION;
	/** Graph data is navigation evidence only; it is never mutation authority. */
	readonly authority: "navigation-only";
	readonly items: readonly T[];
	readonly status: GraphResultStatus;
	readonly freshness: GraphFreshness;
	readonly provenance?: GraphProvenance;
	readonly errors: readonly GraphError[];
	readonly nextCursor?: string;
}

export interface GraphSearchRequest {
	readonly scope: GraphScope;
	readonly query: string;
	readonly kinds?: readonly GraphSearchKind[];
	readonly pathPrefix?: string;
	readonly limit?: number;
	readonly cursor?: string;
}

export interface GraphSymbolRequest {
	readonly scope: GraphScope;
	readonly symbolId?: string;
	readonly name?: string;
	readonly path?: string;
	readonly limit?: number;
}

export interface GraphRelationRequest {
	readonly scope: GraphScope;
	readonly symbolId: string;
	readonly direction?: GraphRelationDirection;
	readonly kinds?: readonly GraphRelationKind[];
	readonly depth?: number;
	readonly limit?: number;
}

export interface GraphImpactRequest {
	readonly scope: GraphScope;
	readonly symbolId: string;
	readonly direction?: "inbound" | "outbound";
	readonly relationKinds?: readonly GraphRelationKind[];
	readonly maxDepth?: number;
	readonly limit?: number;
}

export interface GraphFreshnessRequest {
	readonly scope: GraphScope;
	readonly paths?: readonly string[];
}

export interface GraphIndexFile {
	readonly path: string;
	readonly contentHash: string;
	readonly source?: GraphIndexSource;
	readonly language?: string;
	readonly symbols: readonly GraphSymbol[];
	readonly relations: readonly GraphRelation[];
}

export interface GraphIndexRequest {
	readonly scope: GraphScope;
	readonly files: readonly GraphIndexFile[];
	readonly indexVersion?: string;
	readonly reason?: "initial" | "changed-files" | "branch-switch" | "committed-patch" | "manual";
}

export interface GraphIndexResponse {
	readonly version: typeof GRAPH_CONTRACT_VERSION;
	readonly authority: "navigation-only";
	readonly indexedFiles: readonly string[];
	readonly skippedFiles: readonly string[];
	readonly status: GraphResultStatus;
	readonly freshness: GraphFreshness;
	readonly provenance?: GraphProvenance;
	readonly errors: readonly GraphError[];
}

export interface GraphQueryOptions {
	readonly signal?: AbortSignal;
}

export interface GraphProvider {
	readonly id: string;
	readonly version: string;
	search(request: GraphSearchRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphSearchHit>>;
	findSymbol(request: GraphSymbolRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphSymbol>>;
	relations(request: GraphRelationRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphRelation>>;
	impact(request: GraphImpactRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphSymbol>>;
	freshness(request: GraphFreshnessRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphLocation>>;
	index(request: GraphIndexRequest, options?: GraphQueryOptions): Promise<GraphIndexResponse>;
}

/**
 * H3-03 deliberately exposes only a read interface for the authoritative
 * source. #927 supplies the implementation. No graph provider receives a
 * write method or a mutation-authorizing return type.
 */
export interface AuthoritativeSourceReader {
	read(request: AuthoritativeSourceReadRequest): Promise<AuthoritativeSourceSnapshot>;
}

export interface AuthoritativeSourceReadRequest {
	readonly scope: GraphScope;
	readonly path: string;
	readonly expected?: {
		readonly commit?: string;
		readonly contentHash?: string;
	};
	readonly signal?: AbortSignal;
}

export interface AuthoritativeSourceSnapshot {
	readonly scope: GraphScope;
	readonly path: string;
	readonly contentHash: string;
	readonly commit?: string;
	readonly bytes: number;
	readonly content: string;
}

export class GraphContractError extends Error {
	readonly errors: readonly string[];

	constructor(errors: readonly string[]) {
		super(`Invalid graph contract: ${errors.join("; ")}`);
		this.name = "GraphContractError";
		this.errors = [...errors];
	}
}

const repositoryIdentitySchema = z.object({
	provider: identifier,
	id: identifier,
	revision: boundedString.optional(),
});
const worktreeSchema = z.object({
	id: identifier,
	branch: boundedString.optional(),
	commit: boundedString.optional(),
	dirty: z.boolean().optional(),
	overlay: z.enum(["clean", "uncommitted", "unknown"]).optional(),
});
const contentHashesSchema = z.record(path, digest);
const scopeSchema = z.object({
	repository: repositoryIdentitySchema,
	worktree: worktreeSchema.optional(),
	commit: boundedString.optional(),
	contentHashes: contentHashesSchema.optional(),
});
const positionSchema = z.object({
	line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	column: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
const rangeSchema = z.object({ start: positionSchema, end: positionSchema.optional() });
const locationSchema = z.object({
	path,
	range: rangeSchema.optional(),
	language: identifier.optional(),
	contentHash: digest.optional(),
});
const provenanceSchema = z.object({
	source: z.literal("derived-index"),
	provider: identifier,
	providerVersion: boundedString.optional(),
	indexVersion: boundedString,
	repository: repositoryIdentitySchema,
	worktree: worktreeSchema.optional(),
	commit: boundedString.optional(),
	contentHash: digest.optional(),
	path: path.optional(),
	range: rangeSchema.optional(),
	indexedAt: timestamp.optional(),
});
const freshnessSchema = z.object({
	state: z.enum(GRAPH_FRESHNESS_STATES),
	indexedAt: timestamp.optional(),
	checkedAt: timestamp,
	indexedCommit: boundedString.optional(),
	observedCommit: boundedString.optional(),
	indexedContentHash: digest.optional(),
	observedContentHash: digest.optional(),
	reason: boundedString.optional(),
});
const resultStatusSchema = z
	.object({
		primary: z.enum(GRAPH_RESULT_STATES),
		states: z.array(z.enum(GRAPH_RESULT_STATES)).min(1).max(GRAPH_RESULT_STATES.length),
		complete: z.boolean(),
	})
	.superRefine((value, context) => {
		if (!value.states.includes(value.primary)) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["primary"], message: "primary must be listed in states" });
		}
		if (new Set(value.states).size !== value.states.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["states"], message: "states must be unique" });
		}
		const completeStates = value.states.every((state) => state === "fresh");
		if (value.complete !== completeStates) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["complete"],
				message: "complete is true only for a fresh result",
			});
		}
	});
const errorSchema = z.object({
	code: identifier,
	category: z.enum([
		"provider-unavailable",
		"invalid-query",
		"not-found",
		"unsupported",
		"stale",
		"conflict",
		"limit-exceeded",
		"cancelled",
		"index-failed",
		"internal",
	]),
	message: boundedString,
	retryable: z.boolean(),
	guidance: z.enum(["reread-authoritative-source", "retry", "narrow-query", "inspect-provider", "none"]),
	path: path.optional(),
});
const symbolSchema: z.ZodType<GraphSymbol> = z.object({
	id: identifier,
	name: boundedString,
	kind: z.enum(GRAPH_SYMBOL_KINDS),
	location: locationSchema,
	language: identifier.optional(),
	signature: boundedString.optional(),
	containerId: identifier.optional(),
	exported: z.boolean().optional(),
});
const relationSchema: z.ZodType<GraphRelation> = z.object({
	id: identifier,
	from: identifier,
	to: identifier,
	kind: z.enum(GRAPH_RELATION_KINDS),
	location: locationSchema.optional(),
});
const searchHitSchema: z.ZodType<GraphSearchHit> = z.object({
	id: identifier,
	kind: z.enum(GRAPH_SEARCH_KINDS),
	name: boundedString,
	score: z.number().finite().min(0).max(1),
	symbol: symbolSchema.optional(),
	location: locationSchema.optional(),
});

const requestLimit = z.number().int().positive().max(GRAPH_MAX_ITEMS).optional();
export const GraphRepositoryIdentitySchema = repositoryIdentitySchema;
export const GraphWorktreeIdentitySchema = worktreeSchema;
export const GraphScopeSchema = scopeSchema;
export const GraphRangeSchema = rangeSchema;
export const GraphLocationSchema = locationSchema;
export const GraphProvenanceSchema = provenanceSchema;
export const GraphFreshnessSchema = freshnessSchema;
export const GraphResultStatusSchema = resultStatusSchema;
export const GraphErrorSchema = errorSchema;
export const GraphSymbolSchema = symbolSchema;
export const GraphRelationSchema = relationSchema;
export const GraphSearchHitSchema = searchHitSchema;

export const GraphSearchRequestSchema = z.object({
	scope: scopeSchema,
	query: boundedString,
	kinds: z.array(z.enum(GRAPH_SEARCH_KINDS)).max(GRAPH_SEARCH_KINDS.length).optional(),
	pathPrefix: path.optional(),
	limit: requestLimit,
	cursor: boundedString.optional(),
});
export const GraphSymbolRequestSchema = z
	.object({
		scope: scopeSchema,
		symbolId: identifier.optional(),
		name: boundedString.optional(),
		path: path.optional(),
		limit: requestLimit,
	})
	.refine((value) => value.symbolId !== undefined || value.name !== undefined, "symbolId or name is required");
export const GraphRelationRequestSchema = z.object({
	scope: scopeSchema,
	symbolId: identifier,
	direction: z.enum(GRAPH_RELATION_DIRECTIONS).optional(),
	kinds: z.array(z.enum(GRAPH_RELATION_KINDS)).max(GRAPH_RELATION_KINDS.length).optional(),
	depth: z.number().int().positive().max(GRAPH_MAX_DEPTH).optional(),
	limit: requestLimit,
});
export const GraphImpactRequestSchema = z.object({
	scope: scopeSchema,
	symbolId: identifier,
	direction: z.enum(["inbound", "outbound"]).optional(),
	relationKinds: z.array(z.enum(GRAPH_RELATION_KINDS)).max(GRAPH_RELATION_KINDS.length).optional(),
	maxDepth: z.number().int().positive().max(GRAPH_MAX_DEPTH).optional(),
	limit: requestLimit,
});
export const GraphFreshnessRequestSchema = z.object({
	scope: scopeSchema,
	paths: z.array(path).max(GRAPH_MAX_ITEMS).optional(),
});
export const GraphIndexFileSchema: z.ZodType<GraphIndexFile> = z.object({
	path,
	contentHash: digest,
	source: z.enum(GRAPH_INDEX_SOURCES).optional(),
	language: identifier.optional(),
	symbols: z.array(symbolSchema).max(GRAPH_MAX_ITEMS),
	relations: z.array(relationSchema).max(GRAPH_MAX_ITEMS),
});
export const GraphIndexRequestSchema = z.object({
	scope: scopeSchema,
	files: z.array(GraphIndexFileSchema).min(1).max(GRAPH_MAX_FILES_PER_INDEX),
	indexVersion: boundedString.optional(),
	reason: z.enum(["initial", "changed-files", "branch-switch", "committed-patch", "manual"]).optional(),
});
export const AuthoritativeSourceReadRequestSchema = z.object({
	scope: scopeSchema,
	path,
	expected: z
		.object({ commit: boundedString.optional(), contentHash: digest.optional() })
		.refine((value) => value.commit !== undefined || value.contentHash !== undefined, "an expected version is required")
		.optional(),
});
export const AuthoritativeSourceSnapshotSchema = z.object({
	scope: scopeSchema,
	path,
	contentHash: digest,
	commit: boundedString.optional(),
	bytes: z.number().int().nonnegative().max(GRAPH_MAX_INDEX_BYTES),
	content: z.string().max(GRAPH_MAX_INDEX_BYTES),
});

const baseResponseSchema = z.object({
	version: z.literal(GRAPH_CONTRACT_VERSION),
	authority: z.literal("navigation-only"),
	status: resultStatusSchema,
	freshness: freshnessSchema,
	provenance: provenanceSchema.optional(),
	errors: z.array(errorSchema).max(GRAPH_MAX_ITEMS),
	nextCursor: boundedString.optional(),
});

function assertRecordSize<T>(value: T, label: string, maximum: number): T {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new GraphContractError([`${label} must be JSON-serializable`]);
	}
	if (new TextEncoder().encode(serialized).byteLength > maximum) {
		throw new GraphContractError([`${label} exceeds ${maximum} bytes`]);
	}
	return value;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new GraphContractError(
			result.error.issues.map(
				(issue) => `${label}${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""} ${issue.message}`,
			),
		);
	}
	return result.data;
}

export function parseGraphScope(value: unknown): GraphScope {
	return parse(scopeSchema, value, "graph scope");
}

export function parseGraphSearchRequest(value: unknown): GraphSearchRequest {
	return parse(GraphSearchRequestSchema, value, "graph search request");
}

export function parseGraphSymbolRequest(value: unknown): GraphSymbolRequest {
	return parse(GraphSymbolRequestSchema, value, "graph symbol request");
}

export function parseGraphRelationRequest(value: unknown): GraphRelationRequest {
	return parse(GraphRelationRequestSchema, value, "graph relation request");
}

export function parseGraphImpactRequest(value: unknown): GraphImpactRequest {
	return parse(GraphImpactRequestSchema, value, "graph impact request");
}

export function parseGraphFreshnessRequest(value: unknown): GraphFreshnessRequest {
	return parse(GraphFreshnessRequestSchema, value, "graph freshness request");
}

export function parseGraphIndexRequest(value: unknown): GraphIndexRequest {
	return assertRecordSize(
		parse(GraphIndexRequestSchema, value, "graph index request"),
		"graph index request",
		GRAPH_MAX_INDEX_BYTES,
	);
}

export function parseAuthoritativeSourceReadRequest(value: unknown): AuthoritativeSourceReadRequest {
	return parse(AuthoritativeSourceReadRequestSchema, value, "authoritative source read request");
}

export function parseGraphQueryResponse<T>(itemSchema: z.ZodType<T>, value: unknown): GraphQueryResponse<T> {
	return assertRecordSize(
		parse(
			baseResponseSchema.extend({ items: z.array(itemSchema).max(GRAPH_MAX_ITEMS) }),
			value,
			"graph query response",
		),
		"graph query response",
		GRAPH_MAX_RESPONSE_BYTES,
	);
}

export function parseGraphIndexResponse(value: unknown): GraphIndexResponse {
	return assertRecordSize(
		parse(
			baseResponseSchema.omit({ nextCursor: true }).extend({
				indexedFiles: z.array(path).max(GRAPH_MAX_FILES_PER_INDEX),
				skippedFiles: z.array(path).max(GRAPH_MAX_FILES_PER_INDEX),
			}),
			value,
			"graph index response",
		),
		"graph index response",
		GRAPH_MAX_RESPONSE_BYTES,
	);
}

export function serializeGraphContract(value: unknown): string {
	return JSON.stringify(value);
}
