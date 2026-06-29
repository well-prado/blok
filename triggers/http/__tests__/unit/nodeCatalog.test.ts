import { describe, expect, it } from "vitest";
import { buildNodeCatalog, reflectModuleNode } from "../../src/runner/nodeCatalog";

/** A defineNode-style node exposing real reflection schemas. */
function fnNode(name: string, description: string) {
	return {
		name,
		description,
		getReflectionSchemas: () => ({
			input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
			output: { type: "object", properties: { ok: { type: "boolean" } } },
		}),
		getSchemas: () => ({ input: {}, output: {} }), // validation stubs — must NOT win
	};
}

describe("reflectModuleNode (SPEC-B P1.3)", () => {
	it("prefers getReflectionSchemas() (real schema) over getSchemas() (validation stub)", () => {
		const r = reflectModuleNode(fnNode("@x/a", "desc"));
		expect(r.name).toBe("@x/a");
		expect(r.description).toBe("desc");
		expect((r.inputSchema as { type?: string }).type).toBe("object");
		expect((r.outputSchema as { type?: string }).type).toBe("object");
	});

	it("falls back to getSchemas() for class nodes; empty {} schema → null", () => {
		const classNode = { name: "@x/legacy", getSchemas: () => ({ input: {}, output: { type: "string" } }) };
		const r = reflectModuleNode(classNode);
		expect(r.inputSchema).toBeNull(); // {} normalized to null
		expect((r.outputSchema as { type?: string }).type).toBe("string");
	});

	it("returns null schemas for a node with neither accessor", () => {
		const r = reflectModuleNode({ name: "@x/bare" });
		expect(r.inputSchema).toBeNull();
		expect(r.outputSchema).toBeNull();
	});
});

describe("buildNodeCatalog (SPEC-B P1.3)", () => {
	it("aggregates module nodes + runtime nodes with correct runtime labels", async () => {
		const moduleNodes = new Map<string, unknown>([
			["@x/a", fnNode("@x/a", "node a")],
			["@x/b", { name: "@x/b", getSchemas: () => ({ input: {}, output: {} }) }],
		]);
		const runtimes = [
			{
				kind: "python3",
				adapter: {
					listNodes: async () => [
						{
							name: "@py/search",
							description: "py search",
							inputSchema: { type: "object" },
							outputSchema: null,
							tags: ["ml"],
						},
					],
				},
			},
		];

		const catalog = await buildNodeCatalog(moduleNodes, runtimes);

		expect(catalog).toHaveLength(3);
		const a = catalog.find((n) => n.name === "@x/a");
		expect(a?.runtime).toBe("module");
		expect((a?.inputSchema as { type?: string }).type).toBe("object");
		const py = catalog.find((n) => n.name === "@py/search");
		expect(py?.runtime).toBe("runtime.python3");
		expect(py?.tags).toEqual(["ml"]);
		expect(py?.outputSchema).toBeNull();
	});

	it("exposes the resolvable `use` ref per kind: module=Map key, runtime=runtime.<kind>:<name>", async () => {
		const moduleNodes = new Map<string, unknown>([
			// name === key
			["@blokjs/api-call", fnNode("@blokjs/api-call", "api call")],
			// name !== key: the registry key is what an author types in `use:`, NOT the display name
			["@blokjs/respond", { name: "Respond", getSchemas: () => ({ input: {}, output: {} }) }],
			// empty schema (null) still gets a ref
			["@x/bare", { name: "@x/bare" }],
		]);
		const runtimes = [
			{
				kind: "python3",
				adapter: { listNodes: async () => [{ name: "search", inputSchema: null, outputSchema: null }] },
			},
		];

		const catalog = await buildNodeCatalog(moduleNodes, runtimes);

		// module, name === key
		expect(catalog.find((n) => n.name === "@blokjs/api-call")?.ref).toBe("@blokjs/api-call");
		// module, name !== key → ref is the resolvable key, not the display name
		const respond = catalog.find((n) => n.name === "Respond");
		expect(respond?.ref).toBe("@blokjs/respond");
		expect(respond?.ref).not.toBe(respond?.name);
		// module with empty/null schema still carries a ref
		expect(catalog.find((n) => n.name === "@x/bare")?.ref).toBe("@x/bare");
		// runtime node → runtime.<kind>:<name>
		expect(catalog.find((n) => n.name === "search")?.ref).toBe("runtime.python3:search");
	});

	it("skips an unreachable runtime (listNodes rejects) without failing the catalog", async () => {
		const runtimes = [
			{ kind: "rust", adapter: { listNodes: async () => Promise.reject(new Error("connection refused")) } },
			{ kind: "go", adapter: { listNodes: async () => [{ name: "@go/x", inputSchema: null, outputSchema: null }] } },
		];
		const catalog = await buildNodeCatalog(new Map(), runtimes);
		expect(catalog.map((n) => n.name)).toEqual(["@go/x"]); // rust skipped, go present
	});

	it("skips adapters that don't implement listNodes", async () => {
		const catalog = await buildNodeCatalog(new Map(), [{ kind: "nodejs", adapter: {} }]);
		expect(catalog).toEqual([]);
	});

	it("sorts by runtime then name (module before runtime.*)", async () => {
		const moduleNodes = new Map<string, unknown>([
			["z", { name: "z" }],
			["a", { name: "a" }],
		]);
		const runtimes = [
			{
				kind: "python3",
				adapter: { listNodes: async () => [{ name: "@py/b", inputSchema: null, outputSchema: null }] },
			},
		];
		const catalog = await buildNodeCatalog(moduleNodes, runtimes);
		expect(catalog.map((n) => `${n.runtime}:${n.name}`)).toEqual(["module:a", "module:z", "runtime.python3:@py/b"]);
	});

	it("handles no module nodes + no runtimes", async () => {
		expect(await buildNodeCatalog(undefined, [])).toEqual([]);
	});
});
