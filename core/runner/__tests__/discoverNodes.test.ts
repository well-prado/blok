import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeBase } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Configuration from "../src/Configuration";
import NodeMap from "../src/NodeMap";
import type RunnerNode from "../src/RunnerNode";
import { RuntimeRegistry } from "../src/RuntimeRegistry";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "../src/adapters/RuntimeAdapter";
import { discoverNodes } from "../src/discoverNodes";
import type GlobalOptions from "../src/types/GlobalOptions";

// Expose the protected resolver chain without re-implementing dispatch — same
// shape the #352/#359 nets use. `nodeResolver` routes `type: "module"` →
// `moduleResolver` and `type: "runtime.*"` → `runtimeResolver`.
class TestConfiguration extends Configuration {
	public resolve(node: RunnerNode): Promise<RunnerNode> {
		return this.nodeResolver(node);
	}
}

// A sentinel mock adapter — `transport: "http"` is a value the auto-provisioned
// GrpcRuntimeAdapter NEVER carries, so seeing it on the resolved node proves the
// resolver reached THIS mock (not a default gRPC adapter needing a live SDK).
function makeMock(kind: RuntimeKind): RuntimeAdapter {
	const ok: ExecutionResult = { success: true, data: { ok: true }, errors: null };
	return { kind, transport: "http", execute: async () => ok } as unknown as RuntimeAdapter;
}

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "blok-discover-"));
	const nodeFile = (name: string) => `export default { name: ${JSON.stringify(name)}, async process() {} };\n`;
	// Regular convention: <name>/index.mjs
	mkdirSync(join(root, "alpha"), { recursive: true });
	writeFileSync(join(root, "alpha", "index.mjs"), nodeFile("alpha"));
	mkdirSync(join(root, "beta"), { recursive: true });
	writeFileSync(join(root, "beta", "index.mjs"), nodeFile("@my/beta"));
	// A dir without an index → skipped.
	mkdirSync(join(root, "no-index"), { recursive: true });
	writeFileSync(join(root, "no-index", "helper.mjs"), "export const x = 1;\n");
	// Underscore-prefixed dir → skipped (drafts/utilities).
	mkdirSync(join(root, "_wip"), { recursive: true });
	writeFileSync(join(root, "_wip", "index.mjs"), nodeFile("wip"));
	// A MAP-EXPORT barrel (default export is a `{ ref: node }` map) → every
	// node-shaped value is registered (#360 / #383). The dev app's
	// `examples/`/`eval/` bundles. Non-node values in the map are ignored.
	mkdirSync(join(root, "examples"), { recursive: true });
	writeFileSync(join(root, "examples", "index.mjs"), "export default { 'ex-a': { name: 'ex-a' } };\n");
	mkdirSync(join(root, "bundle"), { recursive: true });
	writeFileSync(
		join(root, "bundle", "index.mjs"),
		"export default { x: { name: 'node-x' }, y: { name: 'node-y' }, util: { notANode: true } };\n",
	);
	// A plain util barrel (no node-shaped values) → registers nothing.
	mkdirSync(join(root, "utils-only"), { recursive: true });
	writeFileSync(join(root, "utils-only", "index.mjs"), "export default { helperA: () => 1, helperB: 2 };\n");
	// A discovered node whose name is a RUNTIME ref ("runtime.<kind>:<name>") —
	// the shape `blokctl nodes sync` writes for a cross-runtime stub (#358/#383).
	// It registers under that ref and resolves through the real resolver chain.
	mkdirSync(join(root, "py-stub"), { recursive: true });
	writeFileSync(join(root, "py-stub", "index.mjs"), nodeFile("runtime.python3:ask"));
});

// Collision fixtures live in their OWN tree so the happy-path scan above stays
// clean — two dirs (and a barrel) claim the SAME `node.name`. discoverNodes
// returns both; NodeMap.addNodes is where the import=registration shadow guard
// fires (#383). Built lazily by the collision tests.
function makeCollisionRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "blok-discover-clash-"));
	const nodeFile = (name: string) => `export default { name: ${JSON.stringify(name)}, async process() {} };\n`;
	mkdirSync(join(dir, "log-a"), { recursive: true });
	writeFileSync(join(dir, "log-a", "index.mjs"), nodeFile("@blokjs/log"));
	mkdirSync(join(dir, "log-b"), { recursive: true });
	writeFileSync(join(dir, "log-b", "index.mjs"), nodeFile("@blokjs/log"));
	return dir;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("discoverNodes", () => {
	it("discovers single-node dirs AND map-export barrels (node-shaped values only)", async () => {
		const nodes = await discoverNodes(root);
		const names = nodes.map((n) => (n as { name: string }).name).sort();
		// alpha + @my/beta + runtime.python3:ask (single nodes); ex-a, node-x, node-y
		// (barrel values); no-index + _wip dirs skipped; util/helper non-node values
		// skipped. A runtime-ref name is just a name — discovery treats it like any other.
		expect(names).toEqual(["@my/beta", "alpha", "ex-a", "node-x", "node-y", "runtime.python3:ask"]);
	});

	it("a map-export barrel registers each node value; a non-node util barrel registers nothing", async () => {
		const map = new NodeMap();
		map.addNodes(await discoverNodes(root));
		expect(map.getNode("node-x")).toBeDefined();
		expect(map.getNode("node-y")).toBeDefined();
		expect(map.getNode("ex-a")).toBeDefined();
		// `utils-only` (helperA/helperB) and the barrel's `util` value contribute none.
		expect(map.getNode("helperA")).toBeUndefined();
		expect(map.getNode("util")).toBeUndefined();
	});

	it("returns [] for a missing directory (project with no local nodes)", async () => {
		expect(await discoverNodes(join(root, "does-not-exist"))).toEqual([]);
	});

	it("registers discovered nodes under their node.name (auto-registration)", async () => {
		const map = new NodeMap();
		map.addNodes(await discoverNodes(root));
		expect(map.getNode("alpha")).toBeDefined();
		expect((map.getNode("@my/beta") as unknown as { name: string }).name).toBe("@my/beta");
	});

	it("addNodes throws if a node lacks a name", () => {
		const map = new NodeMap();
		expect(() => map.addNodes([{} as NodeBase])).toThrow(/no string `name`/);
	});

	// (a) NAME COLLISION (#383) — the import=registration shadow guard, end-to-end
	// through the discovery flow (NOT the synthetic batch in NodeMap.test.ts).
	describe("name collision during discovery", () => {
		it("two discovered dirs claiming the SAME node.name → addNodes THROWS naming the ref", async () => {
			const clashRoot = makeCollisionRoot();
			try {
				const nodes = await discoverNodes(clashRoot);
				// Discovery itself is NOT silent last-wins — both dirs surface.
				const names = nodes.map((n) => (n as { name: string }).name);
				expect(names.filter((n) => n === "@blokjs/log")).toHaveLength(2);
				// The guard fires at registration, and the error NAMES the colliding ref.
				const map = new NodeMap();
				expect(() => map.addNodes(nodes)).toThrow(/registration conflict.*@blokjs\/log/i);
			} finally {
				rmSync(clashRoot, { recursive: true, force: true });
			}
		});

		it("a barrel exporting two DIFFERENT nodes under the same name → addNodes THROWS naming the ref", async () => {
			const dir = mkdtempSync(join(tmpdir(), "blok-discover-barrel-clash-"));
			try {
				mkdirSync(join(dir, "dupes"), { recursive: true });
				// Two DISTINCT node objects sharing one name (idempotent same-instance
				// would be a no-op; the guard only fires on a different node).
				writeFileSync(
					join(dir, "dupes", "index.mjs"),
					"export default { a: { name: 'dup', tag: 1 }, b: { name: 'dup', tag: 2 } };\n",
				);
				const nodes = await discoverNodes(dir);
				expect(nodes).toHaveLength(2);
				const map = new NodeMap();
				expect(() => map.addNodes(nodes)).toThrow(/registration conflict.*dup/i);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// (b) RUNTIME-STUB REGISTRATION (#383) — a discovered node whose name is a
	// runtime ref registers under that ref and resolves through the REAL resolver
	// chain (reusing the #352/#359 TestConfiguration seam, no re-implemented dispatch).
	describe("runtime-stub registration resolves via the resolver chain", () => {
		afterAll(() => RuntimeRegistry.getInstance().clear());

		it("a discovered `runtime.python3:ask` node registers + resolves to the python3 adapter", async () => {
			// Pre-seed the sentinel mock — initializeRuntimeRegistry skips kinds the
			// registry already has, so Configuration won't clobber it with a real gRPC adapter.
			RuntimeRegistry.getInstance().clear();
			RuntimeRegistry.getInstance().register(makeMock("python3"));

			const nodes = await discoverNodes(root);
			const map = new NodeMap();
			map.addNodes(nodes);
			// The runtime-ref node registered under its name (import=registration).
			expect(map.getNode("runtime.python3:ask")).toBeDefined();

			const config = new TestConfiguration();
			(config as unknown as { globalOptions: GlobalOptions }).globalOptions = {
				nodes: map,
			} as unknown as GlobalOptions;

			// The runtime ref routes to runtimeResolver (NOT the module map), landing
			// on the sentinel python3 mock — runtime + transport together prove it.
			const resolved = await config.resolve({
				node: "runtime.python3:ask",
				name: "runtime.python3:ask",
				type: "runtime.python3",
			} as unknown as RunnerNode);
			expect(resolved.type).toBe("runtime.python3");
			expect(resolved.runtime).toBe("python3");
			expect((resolved as RunnerNode & { transport?: string }).transport).toBe("http");
		});
	});
});
