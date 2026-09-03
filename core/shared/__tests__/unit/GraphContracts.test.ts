import { describe, expect, it } from "vitest";
import {
	GraphContractError,
	GraphErrorSchema,
	GraphIndexFileSchema,
	GraphResultStatusSchema,
	GraphSearchHitSchema,
	parseGraphIndexRequest,
	parseGraphQueryResponse,
	parseGraphScope,
} from "../../src/GraphContracts";

const scope = {
	repository: { provider: "github", id: "well-prado/blok" },
	worktree: { id: "wt-1", branch: "main", commit: "abc123", overlay: "clean" },
	commit: "abc123",
};

const hash = `sha256:${"a".repeat(64)}`;

describe("graph contract v1", () => {
	it("normalizes provider-neutral identity and content hashes", () => {
		expect(parseGraphScope({ ...scope, contentHashes: { "src/a.ts": hash.toUpperCase() } })).toMatchObject({
			repository: scope.repository,
			contentHashes: { "src/a.ts": hash },
		});
	});

	it("accepts explicit compound stale/truncated/partial states", () => {
		expect(
			GraphResultStatusSchema.parse({
				primary: "stale",
				states: ["stale", "truncated", "partial"],
				complete: false,
			}),
		).toMatchObject({ primary: "stale", complete: false });
	});

	it("rejects a complete result that is not fresh", () => {
		expect(() =>
			GraphResultStatusSchema.parse({ primary: "conflict", states: ["conflict"], complete: true }),
		).toThrow();
	});

	it("bounds index inputs and response errors at the contract boundary", () => {
		expect(() => parseGraphIndexRequest({ ...scope, files: [] })).toThrow(GraphContractError);
		expect(() =>
			GraphErrorSchema.parse({
				code: "GRAPH_BAD",
				category: "unsupported",
				message: "unsupported",
				retryable: false,
				guidance: "inspect-provider",
			}),
		).not.toThrow();
	});

	it("parses a bounded navigation response without granting mutation authority", () => {
		const symbol = {
			id: "src/a.ts:alpha",
			name: "alpha",
			kind: "function",
			location: { path: "src/a.ts", contentHash: hash },
		};
		const result = parseGraphQueryResponse(GraphSearchHitSchema, {
			version: "1",
			authority: "navigation-only",
			items: [{ id: symbol.id, kind: "symbol", name: symbol.name, score: 1, symbol }],
			status: { primary: "fresh", states: ["fresh"], complete: true },
			freshness: { state: "fresh", checkedAt: "2026-09-02T00:00:00.000Z" },
			errors: [],
		});
		expect(result.authority).toBe("navigation-only");
		expect(result.items[0]?.symbol?.location.contentHash).toBe(hash);
	});

	it("accepts normalized index files with symbol and relation provenance locations", () => {
		const result = GraphIndexFileSchema.parse({
			path: "src/a.ts",
			contentHash: hash,
			symbols: [{ id: "src/a.ts:alpha", name: "alpha", kind: "function", location: { path: "src/a.ts" } }],
			relations: [{ id: "r-1", from: "src/a.ts:alpha", to: "src/a.ts:alpha", kind: "references" }],
		});
		expect(result.path).toBe("src/a.ts");
	});
});
