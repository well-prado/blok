import { Configuration, NodeMap } from "@blokjs/runner";
import { describe, expect, it } from "vitest";
import { type NodeCatalogEntry, buildNodeCatalog, reflectModuleNode } from "../../src/runner/nodeCatalog";

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

/**
 * #356 — the catalog `ref` field (shipped #355) must ROUND-TRIP: every entry the
 * palette offers is resolvable via the SAME resolver chain a workflow step goes
 * through. Build the catalog from a node Map, then for every `entry.ref` run it
 * through `Configuration.nodeResolver` → `moduleResolver` / `runtimeResolver`.
 *
 * Closes the "auto-discovery reintroduces the hand-file" hole: the catalog IS
 * the discovery source, so it must be authoritative + resolvable — never lossy.
 *
 * Reuses the #352 regression harness pattern: a `TestConfiguration` subclass
 * exposing the protected `nodeResolver` (which routes `type: "module"` →
 * `moduleResolver` against `globalOptions.nodes`, and `type: "runtime.*"` →
 * `runtimeResolver` without touching the in-process map).
 */
class TestConfiguration extends Configuration {
	public resolve(node: { node: string; name: string; type: string }): Promise<unknown> {
		return (this as unknown as { nodeResolver(n: unknown): Promise<unknown> }).nodeResolver(node);
	}
}

/** Map a catalog entry to the step shape the resolver consumes (ref === `use:`). */
function stepFor(entry: NodeCatalogEntry): { node: string; name: string; type: string } {
	// inferStepType: "runtime.<kind>:<name>" → type "runtime.<kind>"; else "module".
	const type = entry.ref.startsWith("runtime.") ? entry.runtime : "module";
	return { node: entry.ref, name: entry.ref, type };
}

describe("palette ref round-trips through moduleResolver (#356)", () => {
	// A node registered under a fully-qualified key whose DISPLAY name diverges
	// (the lossy shape the old catalog would have emitted). The catalog's `ref`
	// must be the resolvable key; the display `name` must NOT resolve.
	const divergent = { name: "api-call", getSchemas: () => ({ input: {}, output: {} }) };
	const moduleNodes = new Map<string, unknown>([
		["@blokjs/api-call", divergent], // name "api-call" !== key "@blokjs/api-call"
		["@blokjs/respond", { name: "Respond", getSchemas: () => ({ input: {}, output: {} }) }],
		["@x/bare", { name: "@x/bare" }], // null-schema node — still must carry a resolvable ref
	]);
	const runtimes = [
		{
			kind: "python3",
			adapter: { listNodes: async () => [{ name: "search", inputSchema: null, outputSchema: null }] },
		},
	];

	function buildConfig(nodes: Map<string, unknown>): TestConfiguration {
		const map = new NodeMap();
		for (const [key, node] of nodes) {
			// Register under the catalog key (== ref) — the production keying (#352).
			map.addNode(key, node as never, { replace: true });
		}
		const config = new TestConfiguration();
		(config as unknown as { globalOptions: unknown }).globalOptions = { nodes: map };
		return config;
	}

	it("EVERY catalog ref resolves via the resolver chain (module + runtime)", async () => {
		const catalog = await buildNodeCatalog(moduleNodes, runtimes);
		const config = buildConfig(moduleNodes);
		expect(catalog.length).toBe(4); // 3 module + 1 runtime

		for (const entry of catalog) {
			const resolved = (await config.resolve(stepFor(entry))) as { node?: string; type?: string };
			expect(resolved).toBeDefined();
			// The resolver stamps the step ref back onto the resolved node.
			expect(resolved.node).toBe(entry.ref);
		}
	});

	it("REGRESSION GUARD: the display name as `use` does NOT resolve (proves the lossy form would break)", async () => {
		const catalog = await buildNodeCatalog(moduleNodes, runtimes);
		const config = buildConfig(moduleNodes);

		const apiCall = catalog.find((e) => e.name === "api-call");
		expect(apiCall?.ref).toBe("@blokjs/api-call");
		expect(apiCall?.ref).not.toBe(apiCall?.name);

		// The ref resolves...
		await expect(
			config.resolve({ node: apiCall?.ref as string, name: apiCall?.ref as string, type: "module" }),
		).resolves.toBeDefined();
		// ...but the divergent DISPLAY name (what a lossy catalog would have emitted as `use:`) does NOT.
		await expect(config.resolve({ node: "api-call", name: "api-call", type: "module" })).rejects.toThrow(
			/Node api-call not found/,
		);
	});

	it("runtime ref round-trips through runtimeResolver (no in-process module throw)", async () => {
		const catalog = await buildNodeCatalog(moduleNodes, runtimes);
		const config = buildConfig(moduleNodes);

		const runtimeEntry = catalog.find((e) => e.runtime === "runtime.python3");
		expect(runtimeEntry?.ref).toBe("runtime.python3:search");

		// A runtime ref MUST bypass the module map entirely — resolution succeeds
		// (builds a RuntimeAdapterNode stub) even though no python3 sidecar is up.
		// Crucially it never throws "Node runtime.python3:search not found" — that
		// would prove the catalog handed the palette an unusable ref.
		const resolved = (await config.resolve(stepFor(runtimeEntry as NodeCatalogEntry))) as { type?: string };
		expect(resolved).toBeDefined();
		expect(resolved.type).toBe("runtime.python3");
	});
});
