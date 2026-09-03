import {
	GRAPH_CONTRACT_VERSION,
	type GraphError,
	type GraphFreshness,
	type GraphIndexResponse,
	type GraphProvenance,
	type GraphQueryResponse,
	type GraphRepositoryIdentity,
	type GraphResultState,
	type GraphResultStatus,
	type GraphScope,
	type GraphWorktreeIdentity,
} from "@blokjs/shared";
import { GraphProviderError } from "./GraphProviderError";

export interface IndexedScope {
	readonly repository: GraphRepositoryIdentity;
	readonly worktree?: GraphWorktreeIdentity;
	readonly commit?: string;
}

export function checkCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw GraphProviderError.cancelled();
}

export function makeStatus(primary: GraphResultState, additional: readonly GraphResultState[] = []): GraphResultStatus {
	const states = [...new Set([primary, ...additional])];
	return { primary, states, complete: states.every((state) => state === "fresh") };
}

export function makeError(error: GraphProviderError, path?: string): GraphError {
	return {
		code: error.code,
		category: error.category,
		message: error.message,
		retryable: error.retryable,
		guidance: error.guidance,
		...(path ? { path } : {}),
	};
}

export function makeProvenance(
	provider: string,
	providerVersion: string,
	indexVersion: string,
	scope: IndexedScope,
	indexedAt: string,
): GraphProvenance {
	return {
		source: "derived-index",
		provider,
		providerVersion,
		indexVersion,
		repository: scope.repository,
		...(scope.worktree ? { worktree: scope.worktree } : {}),
		...(scope.commit ? { commit: scope.commit } : {}),
		indexedAt,
	};
}

export function makeFreshness(
	state: GraphFreshness["state"],
	checkedAt: string,
	indexedAt?: string,
	comparison: Partial<
		Pick<GraphFreshness, "indexedCommit" | "observedCommit" | "indexedContentHash" | "observedContentHash" | "reason">
	> = {},
): GraphFreshness {
	return {
		state,
		checkedAt,
		...(indexedAt ? { indexedAt } : {}),
		...comparison,
	};
}

export function response<T>(
	items: readonly T[],
	status: GraphResultStatus,
	freshness: GraphFreshness,
	provenance: GraphProvenance | undefined,
	errors: readonly GraphError[] = [],
	nextCursor?: string,
): GraphQueryResponse<T> {
	return {
		version: GRAPH_CONTRACT_VERSION,
		authority: "navigation-only",
		items,
		status,
		freshness,
		...(provenance ? { provenance } : {}),
		errors,
		...(nextCursor ? { nextCursor } : {}),
	};
}

export function indexResponse(
	indexedFiles: readonly string[],
	skippedFiles: readonly string[],
	status: GraphResultStatus,
	freshness: GraphFreshness,
	provenance: GraphProvenance | undefined,
	errors: readonly GraphError[] = [],
): GraphIndexResponse {
	return {
		version: GRAPH_CONTRACT_VERSION,
		authority: "navigation-only",
		indexedFiles,
		skippedFiles,
		status,
		freshness,
		...(provenance ? { provenance } : {}),
		errors,
	};
}

function sameIdentity(left: GraphRepositoryIdentity, right: GraphRepositoryIdentity): boolean {
	return left.provider === right.provider && left.id === right.id && left.revision === right.revision;
}

function sameWorktree(left?: GraphWorktreeIdentity, right?: GraphWorktreeIdentity): boolean {
	if (!left || !right) return left === right;
	return left.id === right.id && left.branch === right.branch;
}

export function compareScope(
	indexed: IndexedScope | undefined,
	requested: GraphScope,
): {
	state: "fresh" | "stale" | "conflict" | "unknown";
	reason?: string;
	indexedCommit?: string;
	observedCommit?: string;
} {
	if (!indexed) return { state: "unknown", reason: "index is unavailable" };
	if (!sameIdentity(indexed.repository, requested.repository)) {
		return { state: "stale", reason: "repository identity differs" };
	}
	if (!sameWorktree(indexed.worktree, requested.worktree)) {
		return { state: "stale", reason: "worktree identity differs" };
	}
	const requestedCommit = requested.commit ?? requested.worktree?.commit;
	if (indexed.commit !== requestedCommit) {
		return {
			state: "stale",
			reason: "indexed commit differs",
			indexedCommit: indexed.commit,
			observedCommit: requestedCommit,
		};
	}
	if (requested.worktree?.overlay === "uncommitted" || requested.worktree?.dirty === true) {
		return { state: "stale", reason: "working tree has an uncommitted overlay" };
	}
	return { state: "fresh" };
}
