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
	// A barrel dir (default export is a re-export MAP, not a node) → skipped
	// silently. This is the scaffold's `examples/index.ts` case.
	mkdirSync(join(root, "examples"), { recursive: true });
	writeFileSync(join(root, "examples", "index.mjs"), "export default { 'ex-a': { name: 'ex-a' } };\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("discoverNodes", () => {
	it("discovers <name>/index.* nodes by their default export's name", async () => {
		const nodes = await discoverNodes(root);
		const names = nodes.map((n) => (n as { name: string }).name).sort();
		expect(names).toEqual(["@my/beta", "alpha"]); // no-index + _wip skipped
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
