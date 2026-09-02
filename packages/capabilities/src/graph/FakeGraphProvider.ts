import {
	GRAPH_MAX_DEPTH,
	type GraphFreshness,
	type GraphFreshnessRequest,
	type GraphImpactRequest,
	type GraphIndexFile,
	type GraphIndexRequest,
	type GraphIndexResponse,
	type GraphLocation,
	type GraphProvider,
	type GraphQueryOptions,
	type GraphQueryResponse,
	type GraphRelation,
	type GraphRelationRequest,
	type GraphResultState,
	type GraphScope,
	type GraphSearchHit,
	type GraphSearchRequest,
	type GraphSymbol,
	type GraphSymbolRequest,
	parseGraphFreshnessRequest,
	parseGraphImpactRequest,
	parseGraphIndexRequest,
	parseGraphRelationRequest,
	parseGraphSearchRequest,
	parseGraphSymbolRequest,
} from "@blokjs/shared";
import { GraphProviderError } from "./GraphProviderError";
import {
	type IndexedScope,
	checkCancelled,
	compareScope,
	indexResponse,
	makeError,
	makeFreshness,
	makeProvenance,
	makeStatus,
	response,
} from "./GraphProviderSupport";

type FakeOperation = "search" | "symbol" | "relations" | "impact" | "freshness" | "index";

export interface FakeGraphProviderOptions {
	readonly scope?: GraphScope;
	readonly files?: readonly GraphIndexFile[];
	readonly supportedOperations?: readonly FakeOperation[];
	readonly now?: () => string;
}

const DEFAULT_SUPPORTED: readonly FakeOperation[] = ["search", "symbol", "relations", "impact", "freshness", "index"];

function operationError(operation: FakeOperation): GraphProviderError {
	return new GraphProviderError(
		"unsupported",
		"GRAPH_UNSUPPORTED_OPERATION",
		`Graph operation '${operation}' is unsupported`,
		{
			guidance: "inspect-provider",
		},
	);
}

function invalidRequest(error: unknown): GraphProviderError {
	return new GraphProviderError(
		"invalid-query",
		"GRAPH_INVALID_REQUEST",
		error instanceof Error ? error.message : "Invalid graph request",
		{ guidance: "narrow-query" },
	);
}

function missingError(message: string): GraphProviderError {
	return new GraphProviderError("not-found", "GRAPH_NOT_FOUND", message, {
		guidance: "reread-authoritative-source",
	});
}

/** Deterministic in-memory provider used for contract tests and local adapters. */
export class FakeGraphProvider implements GraphProvider {
	readonly id = "fake";
	readonly version = "fake-1";
	private readonly symbols = new Map<string, GraphSymbol>();
	private readonly relationsById = new Map<string, GraphRelation>();
	private readonly indexedHashes = new Map<string, string>();
	private readonly supported: ReadonlySet<FakeOperation>;
	private readonly now: () => string;
	private indexedScope?: IndexedScope;
	private indexedAt?: string;
	private indexVersion = "fake-index-1";

	constructor(options: FakeGraphProviderOptions = {}) {
		this.supported = new Set(options.supportedOperations ?? DEFAULT_SUPPORTED);
		this.now = options.now ?? (() => new Date().toISOString());
		if (options.files && options.scope) {
			this.seed(options.scope, options.files);
		}
	}

	seed(scope: GraphScope, files: readonly GraphIndexFile[]): void {
		const request: GraphIndexRequest = { scope, files, reason: "initial" };
		this.applyIndex(request);
	}

	async search(input: GraphSearchRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphSearchHit>> {
		checkCancelled(options?.signal);
		const request = this.parse(() => parseGraphSearchRequest(input));
		if (!this.supported.has("search")) return this.unsupported("search");
		const limit = request.limit ?? 50;
		const freshness = this.scopeMetadata(request.scope);
		const query = request.query.toLowerCase();
		const kinds = request.kinds ? new Set(request.kinds) : undefined;
		const hits = [...this.symbols.values()]
			.filter((symbol) => !kinds || kinds.has("symbol"))
			.filter((symbol) => !request.pathPrefix || symbol.location.path.startsWith(request.pathPrefix))
			.map((symbol) => ({ symbol, score: this.score(symbol, query) }))
			.filter((match) => match.score > 0)
			.sort((left, right) => right.score - left.score || left.symbol.id.localeCompare(right.symbol.id))
			.map<GraphSearchHit>(({ symbol, score }) => ({
				id: symbol.id,
				kind: "symbol",
				name: symbol.name,
				score,
				symbol,
				location: symbol.location,
			}));
		const truncated = hits.length > limit;
		const items = hits.slice(0, limit);
		const states = truncated ? [freshness.state, "truncated" as const] : [freshness.state];
		if (items.length === 0) states.push("missing");
		return response(
			items,
			makeStatus(states[0] as GraphResultState, states.slice(1)),
			freshness.freshness,
			freshness.provenance,
			items.length === 0 ? [makeError(missingError(`No graph symbols matched '${request.query}'`))] : [],
			truncated ? String(limit) : undefined,
		);
	}

	async findSymbol(input: GraphSymbolRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphSymbol>> {
		checkCancelled(options?.signal);
		const request = this.parse(() => parseGraphSymbolRequest(input));
		if (!this.supported.has("symbol")) return this.unsupported("symbol");
		const limit = request.limit ?? 50;
		const freshness = this.scopeMetadata(request.scope, request.path);
		const items = [...this.symbols.values()]
			.filter((symbol) => (request.symbolId ? symbol.id === request.symbolId : symbol.name === request.name))
			.filter((symbol) => !request.path || symbol.location.path === request.path)
			.sort((left, right) => left.id.localeCompare(right.id))
			.slice(0, limit);
		const states: GraphResultState[] = items.length === 0 ? [freshness.state, "missing"] : [freshness.state];
		return response(
			items,
			makeStatus(states[0], states.slice(1)),
			freshness.freshness,
			freshness.provenance,
			items.length === 0 ? [makeError(missingError("Requested symbol is not present in the graph"))] : [],
		);
	}

	async relations(
		input: GraphRelationRequest,
		options?: GraphQueryOptions,
	): Promise<GraphQueryResponse<GraphRelation>> {
		checkCancelled(options?.signal);
		const request = this.parse(() => parseGraphRelationRequest(input));
		if (!this.supported.has("relations")) return this.unsupported("relations");
		const limit = request.limit ?? 100;
		const direction = request.direction ?? "outbound";
		const kinds = request.kinds ? new Set(request.kinds) : undefined;
		const freshness = this.scopeMetadata(request.scope);
		const items = [...this.relationsById.values()]
			.filter(
				(relation) =>
					(direction === "outbound" && relation.from === request.symbolId) ||
					(direction === "inbound" && relation.to === request.symbolId) ||
					(direction === "both" && (relation.from === request.symbolId || relation.to === request.symbolId)),
			)
			.filter((relation) => !kinds || kinds.has(relation.kind))
			.sort((left, right) => left.id.localeCompare(right.id));
		const truncated = items.length > limit;
		const visible = items.slice(0, limit);
		const states: GraphResultState[] = [freshness.state];
		if (truncated) states.push("truncated");
		if (visible.length === 0) states.push("missing");
		return response(
			visible,
			makeStatus(states[0], states.slice(1)),
			freshness.freshness,
			freshness.provenance,
			visible.length === 0 ? [makeError(missingError("No requested graph relations were found"))] : [],
			truncated ? String(limit) : undefined,
		);
	}

	async impact(input: GraphImpactRequest, options?: GraphQueryOptions): Promise<GraphQueryResponse<GraphSymbol>> {
		checkCancelled(options?.signal);
		const request = this.parse(() => parseGraphImpactRequest(input));
		if (!this.supported.has("impact")) return this.unsupported("impact");
		const direction = request.direction ?? "outbound";
		const maxDepth = request.maxDepth ?? GRAPH_MAX_DEPTH;
		const limit = request.limit ?? 100;
		const kinds = request.relationKinds ? new Set(request.relationKinds) : undefined;
		const freshness = this.scopeMetadata(request.scope);
		const found = new Set<string>();
		const frontier = [{ id: request.symbolId, depth: 0 }];
		while (frontier.length > 0) {
			const current = frontier.shift();
			if (!current || current.depth >= maxDepth) continue;
			for (const relation of this.relationsById.values()) {
				if (kinds && !kinds.has(relation.kind)) continue;
				const next =
					direction === "outbound"
						? relation.from === current.id
							? relation.to
							: undefined
						: relation.to === current.id
							? relation.from
							: undefined;
				if (!next || found.has(next)) continue;
				found.add(next);
				frontier.push({ id: next, depth: current.depth + 1 });
			}
		}
		const items = [...found]
			.map((id) => this.symbols.get(id))
			.filter((symbol): symbol is GraphSymbol => symbol !== undefined)
			.sort((left, right) => left.id.localeCompare(right.id));
		const truncated = items.length > limit;
		const visible = items.slice(0, limit);
		const states: GraphResultState[] = [freshness.state];
		if (truncated) states.push("truncated");
		if (visible.length === 0) states.push("missing");
		return response(
			visible,
			makeStatus(states[0], states.slice(1)),
			freshness.freshness,
			freshness.provenance,
			visible.length === 0 ? [makeError(missingError("No impacted symbols were found"))] : [],
			truncated ? String(limit) : undefined,
		);
	}

	async freshness(
		input: GraphFreshnessRequest,
		options?: GraphQueryOptions,
	): Promise<GraphQueryResponse<GraphLocation>> {
		checkCancelled(options?.signal);
		const request = this.parse(() => parseGraphFreshnessRequest(input));
		if (!this.supported.has("freshness")) return this.unsupported("freshness");
		const paths = request.paths ?? [...this.indexedHashes.keys()].sort();
		const metadata = this.scopeMetadata(request.scope);
		const items = paths
			.filter((candidate) => this.indexedHashes.has(candidate))
			.map((candidate) => ({ path: candidate, contentHash: this.indexedHashes.get(candidate) }) as GraphLocation);
		const missingPaths = paths.filter((candidate) => !this.indexedHashes.has(candidate));
		const states: GraphResultState[] = [metadata.state];
		if (missingPaths.length > 0) states.push("missing");
		return response(
			items,
			makeStatus(states[0], states.slice(1)),
			metadata.freshness,
			metadata.provenance,
			missingPaths.map((path) => makeError(missingError("Path is not present in the graph"), path)),
		);
	}

	async index(input: GraphIndexRequest, options?: GraphQueryOptions): Promise<GraphIndexResponse> {
		checkCancelled(options?.signal);
		if (!this.supported.has("index")) {
			const error = operationError("index");
			return indexResponse(
				[],
				[],
				makeStatus("unsupported"),
				makeFreshness("unknown", this.now(), undefined, { reason: error.message }),
				undefined,
				[makeError(error)],
			);
		}
		let request: GraphIndexRequest;
		try {
			request = parseGraphIndexRequest(input);
		} catch (error) {
			throw invalidRequest(error);
		}
		checkCancelled(options?.signal);
		this.applyIndex(request);
		const provenance = this.indexedScope
			? makeProvenance(this.id, this.version, this.indexVersion, this.indexedScope, this.indexedAt ?? this.now())
			: undefined;
		return indexResponse(
			request.files.map((file) => file.path).sort(),
			[],
			makeStatus("fresh"),
			makeFreshness("fresh", this.now(), this.indexedAt),
			provenance,
		);
	}

	private applyIndex(request: GraphIndexRequest): void {
		for (const file of request.files) {
			for (const [id, symbol] of this.symbols) if (symbol.location.path === file.path) this.symbols.delete(id);
			for (const [id, relation] of this.relationsById)
				if (relation.location?.path === file.path) this.relationsById.delete(id);
			for (const symbol of file.symbols) this.symbols.set(symbol.id, symbol);
			for (const relation of file.relations) this.relationsById.set(relation.id, relation);
			this.indexedHashes.set(file.path, file.contentHash);
		}
		this.indexedScope = {
			repository: request.scope.repository,
			worktree: request.scope.worktree,
			commit: request.scope.commit ?? request.scope.worktree?.commit,
		};
		this.indexVersion = request.indexVersion ?? this.indexVersion;
		this.indexedAt = this.now();
	}

	private score(symbol: GraphSymbol, query: string): number {
		const name = symbol.name.toLowerCase();
		const id = symbol.id.toLowerCase();
		if (name === query || id === query) return 1;
		if (name.startsWith(query) || id.startsWith(query)) return 0.9;
		if (name.includes(query) || id.includes(query) || symbol.location.path.toLowerCase().includes(query)) return 0.75;
		return symbol.signature?.toLowerCase().includes(query) ? 0.6 : 0;
	}

	private parse<T>(parser: () => T): T {
		try {
			return parser();
		} catch (error) {
			throw invalidRequest(error);
		}
	}

	private unsupported<T>(operation: FakeOperation): GraphQueryResponse<T> {
		const error = operationError(operation);
		return response(
			[],
			makeStatus("unsupported"),
			makeFreshness("unknown", this.now(), undefined, { reason: error.message }),
			undefined,
			[makeError(error)],
		);
	}

	private scopeMetadata(
		scope: GraphScope,
		path?: string,
	): {
		state: GraphResultState;
		freshness: GraphFreshness;
		provenance?: ReturnType<typeof makeProvenance>;
	} {
		const checkedAt = this.now();
		if (!this.indexedScope || !this.indexedAt) {
			return {
				state: "missing",
				freshness: makeFreshness("unknown", checkedAt, undefined, { reason: "index is unavailable" }),
			};
		}
		const comparison = compareScope(this.indexedScope, scope);
		let state: GraphResultState = comparison.state === "unknown" ? "missing" : comparison.state;
		let reason = comparison.reason;
		let observedContentHash: string | undefined;
		let indexedContentHash: string | undefined;
		const paths = path ? [path] : Object.keys(scope.contentHashes ?? {});
		for (const candidate of paths) {
			const observed = scope.contentHashes?.[candidate];
			const indexed = this.indexedHashes.get(candidate);
			if (observed && indexed && observed !== indexed) {
				state = "conflict";
				reason = "authoritative content hash differs from the index";
				observedContentHash = observed;
				indexedContentHash = indexed;
				break;
			}
			if (observed && !indexed) {
				state = "missing";
				reason = "path is not indexed";
				observedContentHash = observed;
				break;
			}
		}
		const freshnessState = state === "fresh" ? "fresh" : "stale";
		return {
			state,
			freshness: makeFreshness(freshnessState, checkedAt, this.indexedAt, {
				indexedCommit: comparison.indexedCommit,
				observedCommit: comparison.observedCommit,
				indexedContentHash,
				observedContentHash,
				reason,
			}),
			provenance: makeProvenance(this.id, this.version, this.indexVersion, this.indexedScope, this.indexedAt),
		};
	}
}
