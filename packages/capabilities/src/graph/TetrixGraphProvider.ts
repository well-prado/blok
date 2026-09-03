import {
	GraphContractError,
	type GraphFreshnessRequest,
	type GraphImpactRequest,
	type GraphIndexRequest,
	type GraphIndexResponse,
	type GraphLocation,
	GraphLocationSchema,
	type GraphProvenance,
	type GraphProvider,
	type GraphQueryOptions,
	type GraphQueryResponse,
	type GraphRelation,
	type GraphRelationRequest,
	GraphRelationSchema,
	type GraphSearchHit,
	GraphSearchHitSchema,
	type GraphSearchRequest,
	type GraphSymbol,
	type GraphSymbolRequest,
	GraphSymbolSchema,
	parseGraphFreshnessRequest,
	parseGraphImpactRequest,
	parseGraphIndexRequest,
	parseGraphIndexResponse,
	parseGraphQueryResponse,
	parseGraphRelationRequest,
	parseGraphSearchRequest,
	parseGraphSymbolRequest,
} from "@blokjs/shared";
import { GraphProviderError } from "./GraphProviderError";

/**
 * Transport seam for Tetrix. The repository does not vendor a Tetrix client;
 * an integration supplies this narrow transport without exposing its native
 * response shapes to workflows.
 */
export interface TetrixTransport {
	search(request: GraphSearchRequest, options?: GraphQueryOptions): Promise<unknown>;
	findSymbol(request: GraphSymbolRequest, options?: GraphQueryOptions): Promise<unknown>;
	relations(request: GraphRelationRequest, options?: GraphQueryOptions): Promise<unknown>;
	impact(request: GraphImpactRequest, options?: GraphQueryOptions): Promise<unknown>;
	freshness(request: GraphFreshnessRequest, options?: GraphQueryOptions): Promise<unknown>;
	index(request: GraphIndexRequest, options?: GraphQueryOptions): Promise<unknown>;
}

export interface TetrixGraphProviderOptions {
	readonly providerVersion?: string;
	readonly indexVersion?: string;
}

function invalidResponse(error: unknown): GraphProviderError {
	return new GraphProviderError(
		"internal",
		"GRAPH_INVALID_PROVIDER_RESPONSE",
		error instanceof Error ? error.message : "Tetrix returned an invalid graph response",
		{ guidance: "inspect-provider" },
	);
}

function call<T>(operation: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
	return operation()
		.then((value) => {
			try {
				return parse(value);
			} catch (error) {
				if (error instanceof GraphProviderError) throw error;
				if (error instanceof GraphContractError) throw invalidResponse(error);
				throw invalidResponse(error);
			}
		})
		.catch((error: unknown) => {
			if (error instanceof GraphProviderError) throw error;
			throw new GraphProviderError("provider-unavailable", "GRAPH_TETRIX_UNAVAILABLE", String(error), {
				retryable: true,
				guidance: "retry",
			});
		});
}

function validateRequest<T>(parser: () => T, signal?: AbortSignal): T {
	if (signal?.aborted) throw GraphProviderError.cancelled();
	try {
		return parser();
	} catch (error) {
		throw new GraphProviderError(
			"invalid-query",
			"GRAPH_INVALID_REQUEST",
			error instanceof Error ? error.message : "Invalid graph request",
			{ guidance: "narrow-query" },
		);
	}
}

/** First-party seam for Tetrix; only normalized Blok graph contracts escape it. */
export class TetrixGraphProvider implements GraphProvider {
	readonly id = "tetrix";
	readonly version: string;
	private readonly indexVersion: string;

	constructor(
		private readonly transport: TetrixTransport,
		options: TetrixGraphProviderOptions = {},
	) {
		this.version = options.providerVersion ?? "tetrix-1";
		this.indexVersion = options.indexVersion ?? "tetrix-index-unknown";
	}

	search(request: GraphSearchRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphSearchHit>> {
		const normalized = validateRequest(() => parseGraphSearchRequest(request), options?.signal);
		return call(
			() => this.transport.search(normalized, options),
			(value) => this.stampQuery(parseGraphQueryResponse(GraphSearchHitSchema, value), normalized),
		);
	}

	findSymbol(request: GraphSymbolRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphSymbol>> {
		const normalized = validateRequest(() => parseGraphSymbolRequest(request), options?.signal);
		return call(
			() => this.transport.findSymbol(normalized, options),
			(value) => this.stampQuery(parseGraphQueryResponse(GraphSymbolSchema, value), normalized),
		);
	}

	relations(request: GraphRelationRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphRelation>> {
		const normalized = validateRequest(() => parseGraphRelationRequest(request), options?.signal);
		return call(
			() => this.transport.relations(normalized, options),
			(value) => this.stampQuery(parseGraphQueryResponse(GraphRelationSchema, value), normalized),
		);
	}

	impact(request: GraphImpactRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphSymbol>> {
		const normalized = validateRequest(() => parseGraphImpactRequest(request), options?.signal);
		return call(
			() => this.transport.impact(normalized, options),
			(value) => this.stampQuery(parseGraphQueryResponse(GraphSymbolSchema, value), normalized),
		);
	}

	freshness(request: GraphFreshnessRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphLocation>> {
		const normalized = validateRequest(() => parseGraphFreshnessRequest(request), options?.signal);
		return call(
			() => this.transport.freshness(normalized, options),
			(value) => this.stampQuery(parseGraphQueryResponse(GraphLocationSchema, value), normalized),
		);
	}

	index(request: GraphIndexRequest, options?: GraphQueryOptions): Promise<GraphIndexResponse> {
		const normalized = validateRequest(() => parseGraphIndexRequest(request), options?.signal);
		return call(
			() => this.transport.index(normalized, options),
			(value) => this.stampIndex(parseGraphIndexResponse(value), normalized),
		);
	}

	private stampQuery<T>(
		result: GraphQueryResponse<T>,
		request: { scope: GraphSearchRequest["scope"] },
	): GraphQueryResponse<T> {
		return {
			...result,
			provenance: this.provenance(result.provenance, request.scope, result.freshness.indexedAt),
		};
	}

	private stampIndex(result: GraphIndexResponse, request: GraphIndexRequest): GraphIndexResponse {
		return {
			...result,
			provenance: this.provenance(result.provenance, request.scope, result.freshness.indexedAt, request.indexVersion),
		};
	}

	private provenance(
		existing: GraphProvenance | undefined,
		scope: GraphSearchRequest["scope"],
		indexedAt?: string,
		indexVersion = this.indexVersion,
	): GraphProvenance {
		return {
			...(existing ?? {}),
			source: "derived-index",
			provider: this.id,
			providerVersion: this.version,
			indexVersion,
			repository: existing?.repository ?? scope.repository,
			...(existing?.worktree || scope.worktree ? { worktree: existing?.worktree ?? scope.worktree } : {}),
			...(existing?.commit || scope.commit ? { commit: existing?.commit ?? scope.commit } : {}),
			...(existing?.indexedAt || indexedAt ? { indexedAt: existing?.indexedAt ?? indexedAt } : {}),
		};
	}
}
