import type { GraphProvenance } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import {
	type AgentKernelError,
	type ContextItem,
	assembleContext,
	assembleContextWithCompaction,
	contextItem,
	contextItemFromGraph,
	contextItemFromSource,
	invalidateContextItems,
} from "../src";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

const message = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });

function graphProvenance(contentHash = HASH_A): GraphProvenance {
	return {
		source: "derived-index",
		provider: "fake",
		providerVersion: "fake-1",
		indexVersion: "index-1",
		repository: { provider: "github", id: "well-prado/blok" },
		worktree: { id: "worktree-1", branch: "main", commit: "commit-1", overlay: "clean" },
		commit: "commit-1",
		contentHash,
		path: "src/example.ts",
	};
}

function policyItem(): ContextItem {
	return contextItem({
		id: "policy-1",
		message: { role: "system", content: [{ type: "text", text: "Policy instructions" }] },
		provenance: {
			source: "policy",
			sourceId: "policy-1",
			trust: "trusted",
			freshness: "fresh",
			truncated: false,
		},
	});
}

describe("H3-04 context assembly", () => {
	it("orders sources deterministically and prefers current source over stale graph data", async () => {
		const source = contextItemFromSource(
			"source-1",
			message("const current = true"),
			{
				sourceId: "src/example.ts",
				freshness: "fresh",
				truncated: false,
				contentHash: HASH_B,
				invalidation: { paths: ["src/example.ts"], worktreeId: "worktree-1", commit: "commit-1" },
			},
			{ dedupeKey: "file:src/example.ts" },
		);
		const graph = contextItemFromGraph("graph-1", message("const indexed = true"), graphProvenance(HASH_A), {
			freshness: "stale",
			dedupeKey: "file:src/example.ts",
		});
		const workflow = contextItem({
			id: "workflow-1",
			message: { role: "system", content: [{ type: "text", text: "Workflow instructions" }] },
			provenance: {
				source: "workflow",
				sourceId: "workflow-1",
				trust: "trusted",
				freshness: "fresh",
				truncated: false,
			},
		});
		const result = await assembleContext({ items: [graph, source, workflow, policyItem()] });

		expect(result.items.map((item) => item.id)).toEqual(["policy-1", "workflow-1", "source-1"]);
		expect(result.omitted.map((item) => item.id)).toEqual(["graph-1"]);
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "STALE_CONTEXT", itemId: "graph-1" }));
	});

	it("labels untrusted content and enforces byte/token/item budgets", async () => {
		const source = contextItemFromSource("source-1", message("repository text"), {
			freshness: "fresh",
			truncated: false,
		});
		const result = await assembleContext({
			items: [source],
			budgets: { maxBytes: 10_000, maxTokens: 3, maxItems: 4 },
			tokenEstimator: () => 3,
		});

		expect(result.messages[0]?.content[0]).toMatchObject({ type: "text" });
		expect((result.messages[0]?.content[0] as { text: string }).text).toContain("UNTRUSTED REPOSITORY CONTENT");
		expect(result.usage).toMatchObject({ tokens: 3, items: 1 });

		const omitted = await assembleContext({ items: [source, source], budgets: { maxItems: 0 } });
		expect(omitted.items).toHaveLength(0);
		expect(omitted.diagnostics[0]?.code).toBe("CONTEXT_BUDGET_EXCEEDED");
	});

	it("fails closed for same-precedence conflicts and reports missing evidence", async () => {
		const first = contextItemFromSource(
			"source-a",
			message("a"),
			{
				freshness: "fresh",
				truncated: false,
				contentHash: HASH_A,
			},
			{ dedupeKey: "file:same" },
		);
		const second = contextItemFromSource(
			"source-b",
			message("b"),
			{
				freshness: "fresh",
				truncated: false,
				contentHash: HASH_B,
			},
			{ dedupeKey: "file:same" },
		);
		const missing = contextItemFromSource("missing", message("not available"), {
			freshness: "missing",
			truncated: false,
		});
		const result = await assembleContext({ items: [first, second, missing] });

		expect(result.items).toHaveLength(0);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining(["CONFLICTING_CONTEXT", "MISSING_CONTEXT"]),
		);
	});

	it("invalidates changed paths and worktree versions", () => {
		const item = contextItemFromSource("source-1", message("code"), {
			freshness: "fresh",
			truncated: false,
			invalidation: { paths: ["src/example.ts"], worktreeId: "worktree-1", commit: "commit-1" },
		});
		const result = invalidateContextItems([item], {
			changedPaths: ["src/example.ts"],
			worktreeId: "worktree-1",
			commit: "commit-1",
		});

		expect(result.items).toHaveLength(0);
		expect(result.invalidated).toEqual([item]);
		expect(result.diagnostics[0]).toMatchObject({ code: "INVALIDATED_CONTEXT", reason: "path-changed" });
	});

	it("compacts through an injected seam while preserving protected sources", async () => {
		const policy = policyItem();
		const source = contextItemFromSource("source-1", message("large repository text"), {
			freshness: "fresh",
			truncated: false,
		});
		const summary = contextItem({
			id: "summary-1",
			message: { role: "system", content: [{ type: "text", text: "Summary of repository context" }] },
			provenance: { source: "summary", sourceId: "summary-1", trust: "derived", freshness: "fresh", truncated: false },
		});
		const calls: string[] = [];
		const result = await assembleContextWithCompaction(
			{ items: [policy, source], budgets: { maxItems: 1 } },
			{
				async compact(request) {
					calls.push(request.requiredItems[0]?.id ?? "none");
					return { summary, preserved: [policy], replacedItemIds: [source.id] };
				},
			},
		);

		expect(calls).toEqual(["policy-1"]);
		expect(result.compacted).toBe(true);
		expect(result.items.map((item) => item.id)).toEqual(["policy-1"]);
		expect(result.compaction?.replacedItemIds).toEqual(["source-1"]);
	});

	it("turns cancellation into a stable kernel error", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			assembleContext({ items: [policyItem()], signal: controller.signal }),
		).rejects.toMatchObject<AgentKernelError>({
			code: "CANCELLED",
		});
	});
});
