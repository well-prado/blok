import type { GraphIndexFile, GraphProvider, GraphScope, GraphSymbol } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import {
	BoundedGraphIndexer,
	FakeGraphProvider,
	GraphProviderError,
	TetrixGraphProvider,
	type TetrixTransport,
} from "../src";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_CHANGED = `sha256:${"c".repeat(64)}`;

const cleanScope: GraphScope = {
	repository: { provider: "github", id: "well-prado/blok" },
	worktree: { id: "worktree-1", branch: "main", commit: "commit-1", dirty: false, overlay: "clean" },
	commit: "commit-1",
};

const alpha: GraphSymbol = {
	id: "src/a.ts:alpha",
	name: "alpha",
	kind: "function",
	language: "typescript",
	location: {
		path: "src/a.ts",
		range: { start: { line: 1, column: 1 }, end: { line: 3, column: 2 } },
		contentHash: HASH_A,
	},
};
const beta: GraphSymbol = {
	id: "src/b.ts:beta",
	name: "beta",
	kind: "function",
	language: "typescript",
	location: { path: "src/b.ts", range: { start: { line: 1 }, end: { line: 4 } }, contentHash: HASH_B },
};
const files: readonly GraphIndexFile[] = [
	{
		path: "src/a.ts",
		contentHash: HASH_A,
		symbols: [alpha],
		relations: [{ id: "r-alpha-beta", from: alpha.id, to: beta.id, kind: "calls" }],
	},
	{ path: "src/b.ts", contentHash: HASH_B, symbols: [beta], relations: [] },
];

function makeProvider(): FakeGraphProvider {
	return new FakeGraphProvider({ scope: cleanScope, files, now: () => "2026-09-02T00:00:00.000Z" });
}

function hasState(result: { status: { states: readonly string[] } }, state: string): boolean {
	return result.status.states.includes(state);
}

describe("graph provider contract", () => {
	it("returns deterministic symbols, relations, impact, and navigation-only provenance", async () => {
		const provider = makeProvider();
		const search = await provider.search({ scope: cleanScope, query: "alpha" });
		const relation = await provider.relations({ scope: cleanScope, symbolId: alpha.id });
		const impact = await provider.impact({ scope: cleanScope, symbolId: alpha.id });

		expect(search.items.map((item) => item.id)).toEqual([alpha.id]);
		expect(relation.items.map((item) => item.to)).toEqual([beta.id]);
		expect(impact.items.map((item) => item.id)).toEqual([beta.id]);
		expect(search.authority).toBe("navigation-only");
		expect(search.provenance).toMatchObject({
			provider: "fake",
			indexVersion: "fake-index-1",
			repository: cleanScope.repository,
			worktree: cleanScope.worktree,
			commit: "commit-1",
			indexedAt: "2026-09-02T00:00:00.000Z",
		});
	});

	it("makes branch switches and uncommitted overlays explicitly stale", async () => {
		const provider = makeProvider();
		const branchSwitch = await provider.search({
			scope: { ...cleanScope, worktree: { ...cleanScope.worktree, id: "worktree-2", branch: "feature" } },
			query: "alpha",
		});
		const overlay = await provider.search({
			scope: { ...cleanScope, worktree: { ...cleanScope.worktree, dirty: true, overlay: "uncommitted" } },
			query: "alpha",
		});

		expect(hasState(branchSwitch, "stale")).toBe(true);
		expect(hasState(overlay, "stale")).toBe(true);
		expect(branchSwitch.freshness.state).toBe("stale");
	});

	it("surfaces content conflicts, missing symbols, truncation, and unsupported operations", async () => {
		const provider = makeProvider();
		const conflict = await provider.findSymbol({
			scope: { ...cleanScope, contentHashes: { "src/a.ts": HASH_CHANGED } },
			symbolId: alpha.id,
		});
		const missing = await provider.findSymbol({ scope: cleanScope, name: "does-not-exist" });
		const limited = await provider.search({ scope: cleanScope, query: "a", limit: 1 });
		const unsupported = await new FakeGraphProvider({ supportedOperations: ["search"] }).findSymbol({
			scope: cleanScope,
			name: "alpha",
		});

		expect(hasState(conflict, "conflict")).toBe(true);
		expect(conflict.freshness.observedContentHash).toBe(HASH_CHANGED);
		expect(hasState(missing, "missing")).toBe(true);
		expect(hasState(limited, "truncated")).toBe(true);
		expect(unsupported.errors[0]).toMatchObject({ category: "unsupported", guidance: "inspect-provider" });
	});

	it("marks a path missing in freshness queries", async () => {
		const result = await makeProvider().freshness({ scope: cleanScope, paths: ["src/missing.ts"] });
		expect(result.items).toEqual([]);
		expect(hasState(result, "missing")).toBe(true);
		expect(result.errors[0]).toMatchObject({ category: "not-found", path: "src/missing.ts" });
	});
});

describe("bounded graph indexing", () => {
	it("deduplicates identical jobs and limits concurrency", async () => {
		let calls = 0;
		let active = 0;
		let peak = 0;
		const provider = makeProvider();
		const slow: GraphProvider = {
			...provider,
			async index(request, options) {
				calls += 1;
				active += 1;
				peak = Math.max(peak, active);
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 10);
					options?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(GraphProviderError.cancelled());
						},
						{ once: true },
					);
				});
				active -= 1;
				return provider.index(request, options);
			},
		};
		const indexer = new BoundedGraphIndexer(slow, { maxConcurrent: 1, maxQueueSize: 3 });
		const firstRequest = { scope: cleanScope, files: [files[0]], reason: "changed-files" as const };
		const secondRequest = { scope: cleanScope, files: [files[1]], reason: "changed-files" as const };
		const first = indexer.enqueue(firstRequest);
		const duplicate = indexer.enqueue(firstRequest);
		const second = indexer.enqueue(secondRequest);

		expect(duplicate.promise).toBe(first.promise);
		await first.promise;
		await second.promise;
		expect(calls).toBe(2);
		expect(peak).toBe(1);
	});

	it("cancels queued work and reports a bounded queue overflow", async () => {
		const provider = makeProvider();
		const slow: GraphProvider = {
			...provider,
			async index(request, options) {
				await new Promise<void>((resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(GraphProviderError.cancelled()), { once: true });
				});
				return provider.index(request);
			},
		};
		const indexer = new BoundedGraphIndexer(slow, { maxConcurrent: 1, maxQueueSize: 2 });
		const first = indexer.enqueue({ scope: cleanScope, files: [files[0]] });
		const second = indexer.enqueue({ scope: cleanScope, files: [files[1]] });
		expect(() => indexer.enqueue({ scope: cleanScope, files: [{ ...files[0], path: "src/c.ts" }] })).toThrow(
			GraphProviderError,
		);
		second.cancel();

		await expect(second.promise).rejects.toMatchObject({ category: "cancelled" });
		first.cancel();
		await expect(first.promise).rejects.toMatchObject({ category: "cancelled" });
	});
});

describe("Tetrix adapter seam", () => {
	it("normalizes transport responses and stamps Tetrix provenance", async () => {
		const fake = makeProvider();
		const transport: TetrixTransport = {
			search: (request, options) => fake.search(request, options),
			findSymbol: (request, options) => fake.findSymbol(request, options),
			relations: (request, options) => fake.relations(request, options),
			impact: (request, options) => fake.impact(request, options),
			freshness: (request, options) => fake.freshness(request, options),
			index: (request, options) => fake.index(request, options),
		};
		const provider = new TetrixGraphProvider(transport, { providerVersion: "tetrix-2", indexVersion: "idx-7" });
		const result = await provider.search({ scope: cleanScope, query: "alpha" });

		expect(result.items[0]?.id).toBe(alpha.id);
		expect(result.provenance).toMatchObject({
			provider: "tetrix",
			providerVersion: "tetrix-2",
			indexVersion: "idx-7",
		});
	});

	it("fails closed when the transport violates the response contract", async () => {
		const invalid: TetrixTransport = {
			search: async () => ({ nope: true }),
			findSymbol: async () => ({ nope: true }),
			relations: async () => ({ nope: true }),
			impact: async () => ({ nope: true }),
			freshness: async () => ({ nope: true }),
			index: async () => ({ nope: true }),
		};
		await expect(new TetrixGraphProvider(invalid).search({ scope: cleanScope, query: "alpha" })).rejects.toMatchObject({
			category: "internal",
			code: "GRAPH_INVALID_PROVIDER_RESPONSE",
		});
	});
});
