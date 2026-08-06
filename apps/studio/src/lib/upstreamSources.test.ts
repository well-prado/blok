import type { NodeCatalogEntry } from "@/lib/api";
import type { NodeRun } from "@/types";
import { describe, expect, it } from "vitest";
import { upstreamSources } from "./upstreamSources";

function catalogEntry(overrides: Partial<NodeCatalogEntry> & Pick<NodeCatalogEntry, "name" | "ref">): NodeCatalogEntry {
	return { ...overrides };
}

function nodeRun(overrides: Partial<NodeRun> & Pick<NodeRun, "nodeName" | "startedAt">): NodeRun {
	return {
		id: `run-${overrides.nodeName}-${overrides.startedAt}`,
		runId: "run-1",
		nodeType: "node",
		status: "completed",
		depth: 0,
		stepIndex: 0,
		...overrides,
	};
}

const definition = {
	trigger: { http: { method: "POST", path: "/x" } },
	steps: [
		{ id: "step-a", use: "pkg/node-a", inputs: {} },
		{
			id: "the-branch",
			branch: {
				when: "ctx.req.method === 'POST'",
				then: [{ id: "nested-b", use: "pkg/node-b", inputs: {} }],
			},
		},
		{ id: "step-c", use: "pkg/node-c", inputs: {}, as: "aliasC" },
		{ id: "raw-dash-id", use: "pkg/node-dash", inputs: {} },
		{ id: "ephemeral-d", use: "pkg/node-d", inputs: {}, ephemeral: true },
		{ id: "spread-e", use: "pkg/node-e", inputs: {}, spread: true },
		{ id: "target", use: "pkg/node-target", inputs: {} },
		{ id: "step-after", use: "pkg/node-after", inputs: {} },
	],
};

describe("upstreamSources", () => {
	it("puts the trigger first with the fixed request fields", () => {
		const sources = upstreamSources(definition, "target", undefined, undefined);
		expect(sources[0]).toEqual({
			kind: "trigger",
			id: "trigger",
			expr: "js/ctx.request.body",
			fields: [
				{ path: "body", expr: "js/ctx.request.body" },
				{ path: "query", expr: "js/ctx.request.query" },
				{ path: "headers", expr: "js/ctx.request.headers" },
			],
		});
	});

	it("cuts strictly before the target in document order, including nested-arm steps, excluding the target and everything after", () => {
		const sources = upstreamSources(definition, "target", undefined, undefined);
		const ids = sources.map((s) => s.id);
		expect(ids).toContain("nested-b"); // inside the branch's `then` arm, before target
		expect(ids).not.toContain("target");
		expect(ids).not.toContain("step-after");
	});

	it("skips ephemeral steps", () => {
		const sources = upstreamSources(definition, "target", undefined, undefined);
		expect(sources.map((s) => s.id)).not.toContain("ephemeral-d");
	});

	it("returns only the trigger when the target step isn't found", () => {
		expect(upstreamSources(definition, "does-not-exist", undefined, undefined)).toEqual([
			expect.objectContaining({ kind: "trigger" }),
		]);
	});

	it("builds fields from the catalog's outputSchema, matched by ref", () => {
		const catalog = [
			catalogEntry({
				name: "Node A",
				ref: "pkg/node-a",
				outputSchema: { properties: { result: { type: "string" }, count: { type: "number" } } },
			}),
		];
		const sources = upstreamSources(definition, "target", catalog, undefined);
		const stepA = sources.find((s) => s.id === "step-a");
		expect(stepA?.expr).toBe('js/ctx.state["step-a"]'); // no `as`, dashed id → bracket form
		expect(stepA?.fields).toEqual([
			{ path: "result", expr: 'js/ctx.state["step-a"].result', type: "string" },
			{ path: "count", expr: 'js/ctx.state["step-a"].count', type: "number" },
		]);
	});

	it("uses dot notation for identifier-safe slots and bracket notation for dashed ids", () => {
		const sources = upstreamSources(definition, "target", undefined, undefined);
		expect(sources.find((s) => s.id === "raw-dash-id")?.expr).toBe('js/ctx.state["raw-dash-id"]');
		expect(sources.find((s) => s.id === "the-branch")?.expr).toBe('js/ctx.state["the-branch"]');
	});

	it("uses the `as` alias for the state slot when present, for both the step and field exprs", () => {
		const catalog = [
			catalogEntry({ name: "Node C", ref: "pkg/node-c", outputSchema: { properties: { value: { type: "string" } } } }),
		];
		const sources = upstreamSources(definition, "target", catalog, undefined);
		const stepC = sources.find((s) => s.id === "step-c");
		expect(stepC?.expr).toBe("js/ctx.state.aliasC");
		expect(stepC?.fields).toEqual([{ path: "value", expr: "js/ctx.state.aliasC.value", type: "string" }]);
	});

	it("represents a spread step's fields at the state root instead of a per-step slot", () => {
		const catalog = [
			catalogEntry({ name: "Node E", ref: "pkg/node-e", outputSchema: { properties: { flag: { type: "boolean" } } } }),
		];
		const sources = upstreamSources(definition, "target", catalog, undefined);
		const stepE = sources.find((s) => s.id === "spread-e");
		expect(stepE?.expr).toBe("js/ctx.state");
		expect(stepE?.fields).toEqual([{ path: "flag", expr: "js/ctx.state.flag", type: "boolean" }]);
	});

	it("falls back to matching the catalog entry by name when no ref matches", () => {
		const catalog = [
			catalogEntry({
				name: "pkg/node-a",
				ref: "runtime.python:node-a",
				outputSchema: { properties: { result: { type: "string" } } },
			}),
		];
		const sources = upstreamSources(definition, "target", catalog, undefined);
		const stepA = sources.find((s) => s.id === "step-a");
		expect(stepA?.fields).toEqual([{ path: "result", expr: 'js/ctx.state["step-a"].result', type: "string" }]);
	});

	it("merges last-run sample keys not present in the schema, attaching sample values, and attaches samples to schema fields too", () => {
		const catalog = [
			catalogEntry({ name: "Node A", ref: "pkg/node-a", outputSchema: { properties: { result: { type: "string" } } } }),
		];
		const lastRunNodes = [nodeRun({ nodeName: "step-a", startedAt: 100, outputs: { result: "ok", extra: "bonus" } })];
		const sources = upstreamSources(definition, "target", catalog, lastRunNodes);
		const stepA = sources.find((s) => s.id === "step-a");
		expect(stepA?.fields).toEqual([
			{ path: "result", expr: 'js/ctx.state["step-a"].result', type: "string", sample: "ok" },
			{ path: "extra", expr: 'js/ctx.state["step-a"].extra', sample: "bonus" },
		]);
	});

	it("picks the latest matching run by startedAt when multiple traces exist for the same step", () => {
		const lastRunNodes = [
			nodeRun({ nodeName: "step-a", startedAt: 100, outputs: { v: "old" } }),
			nodeRun({ nodeName: "step-a", startedAt: 200, outputs: { v: "new" } }),
		];
		const sources = upstreamSources(definition, "target", undefined, lastRunNodes);
		const stepA = sources.find((s) => s.id === "step-a");
		expect(stepA?.fields).toEqual([{ path: "v", expr: 'js/ctx.state["step-a"].v', sample: "new" }]);
	});

	it("ignores non-object outputs when sampling", () => {
		const lastRunNodes = [nodeRun({ nodeName: "step-a", startedAt: 100, outputs: "not-an-object" })];
		const sources = upstreamSources(definition, "target", undefined, lastRunNodes);
		expect(sources.find((s) => s.id === "step-a")?.fields).toEqual([]);
	});
});
