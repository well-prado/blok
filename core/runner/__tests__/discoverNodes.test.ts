import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeBase } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import NodeMap from "../src/NodeMap";
import { discoverNodes } from "../src/discoverNodes";

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
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("discoverNodes", () => {
	it("discovers single-node dirs AND map-export barrels (node-shaped values only)", async () => {
		const nodes = await discoverNodes(root);
		const names = nodes.map((n) => (n as { name: string }).name).sort();
		// alpha + @my/beta (single nodes); ex-a, node-x, node-y (barrel values);
		// no-index + _wip dirs skipped; util/helper non-node values skipped.
		expect(names).toEqual(["@my/beta", "alpha", "ex-a", "node-x", "node-y"]);
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
});
