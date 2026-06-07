import { afterEach, describe, expect, it, vi } from "vitest";
import { type NodeEntry, formatCatalog, listNodes, schemaMark } from "./listNodes.js";

describe("schemaMark", () => {
	it("reports which schemas a node exposes", () => {
		expect(schemaMark({ name: "a", runtime: "module", inputSchema: {}, outputSchema: {} })).toBe("in,out");
		expect(schemaMark({ name: "a", runtime: "module", inputSchema: {}, outputSchema: null })).toBe("in");
		expect(schemaMark({ name: "a", runtime: "module", inputSchema: null, outputSchema: {} })).toBe("out");
		expect(schemaMark({ name: "a", runtime: "module", inputSchema: null, outputSchema: null })).toBe("—");
	});
});

describe("formatCatalog", () => {
	it("renders an aligned table with a header", () => {
		const nodes: NodeEntry[] = [
			{
				name: "@blokjs/respond",
				runtime: "module",
				description: "Shape the HTTP response",
				inputSchema: {},
				outputSchema: null,
			},
			{
				name: "@py/search",
				runtime: "runtime.python3",
				description: "Semantic search",
				inputSchema: {},
				outputSchema: {},
			},
		];
		const out = formatCatalog(nodes);
		const lines = out.split("\n");
		expect(lines[0]).toMatch(/^NAME\s+RUNTIME\s+SCHEMA\s+DESCRIPTION$/);
		expect(out).toContain("@blokjs/respond");
		expect(out).toContain("runtime.python3");
		expect(out).toContain("in,out");
		expect(out).toContain("Semantic search");
		// Columns aligned: every row starts the RUNTIME column at the same offset.
		const rtOffset = lines[0].indexOf("RUNTIME");
		expect(lines[1].slice(rtOffset, rtOffset + 6)).toBe("module");
	});

	it("handles an empty catalog", () => {
		expect(formatCatalog([])).toBe("No nodes found.");
	});
});

describe("listNodes (fetch-mocked)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
		vi.restoreAllMocks();
	});

	it("fetches /__blok/nodes from the given --url and prints the table", async () => {
		let seenUrl = "";
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			seenUrl = String(url);
			return new Response(
				JSON.stringify({ count: 1, nodes: [{ name: "@x/a", runtime: "module", inputSchema: {}, outputSchema: null }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await listNodes({ url: "https://api.test/" });

		expect(seenUrl).toBe("https://api.test/__blok/nodes"); // trailing slash trimmed
		const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("@x/a");
		expect(printed).toContain("1 node(s)");
	});

	it("emits raw JSON with --json", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ nodes: [{ name: "@x/a", runtime: "module", inputSchema: null, outputSchema: null }] }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		) as unknown as typeof fetch;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await listNodes({ url: "http://localhost:4000", json: true });

		const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
		expect(JSON.parse(printed)).toEqual([{ name: "@x/a", runtime: "module", inputSchema: null, outputSchema: null }]);
	});
});
