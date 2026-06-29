import type { NodeBase } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import NodeMap from "../src/NodeMap";

const stub = (id: string): NodeBase => ({ id }) as unknown as NodeBase;

describe("NodeMap.addNode collision guard", () => {
	it("registers a node and resolves it by key", () => {
		const map = new NodeMap();
		const a = stub("a");
		map.addNode("@blokjs/api-call", a);
		expect(map.getNode("@blokjs/api-call")).toBe(a);
	});

	it("throws when a DIFFERENT node claims an existing key (no silent shadowing)", () => {
		const map = new NodeMap();
		map.addNode("@blokjs/jwt-verify", stub("builtin"));
		expect(() => map.addNode("@blokjs/jwt-verify", stub("attacker"))).toThrow(/registration conflict/i);
		// The original builtin is untouched.
		expect((map.getNode("@blokjs/jwt-verify") as unknown as { id: string }).id).toBe("builtin");
	});

	it("is idempotent for the SAME instance (re-registering is a no-op)", () => {
		const map = new NodeMap();
		const a = stub("a");
		map.addNode("x", a);
		expect(() => map.addNode("x", a)).not.toThrow();
	});

	it("allows an intentional override with { replace: true }", () => {
		const map = new NodeMap();
		map.addNode("x", stub("old"));
		const next = stub("new");
		expect(() => map.addNode("x", next, { replace: true })).not.toThrow();
		expect(map.getNode("x")).toBe(next);
	});

	it("HMR: re-registering an EDITED node under the same key with { replace: true } resolves the NEW impl", () => {
		// HMR keys nodes by a stable string (relativePath) and re-runs addNode on
		// every save — the instance changes, the key does not. The edited build wins.
		const map = new NodeMap();
		const original = stub("orig-impl");
		map.addNode("nodes/my-node.ts", original);

		const edited = stub("edited-impl");
		expect(() => map.addNode("nodes/my-node.ts", edited, { replace: true })).not.toThrow();
		expect(map.getNode("nodes/my-node.ts")).toBe(edited);
		expect((map.getNode("nodes/my-node.ts") as unknown as { id: string }).id).toBe("edited-impl");
	});

	it("HMR: rapid double-edit replaces each time, last edit wins", () => {
		const map = new NodeMap();
		map.addNode("nodes/my-node.ts", stub("v1"));
		map.addNode("nodes/my-node.ts", stub("v2"), { replace: true });
		const v3 = stub("v3");
		map.addNode("nodes/my-node.ts", v3, { replace: true });
		expect(map.getNode("nodes/my-node.ts")).toBe(v3);
	});

	it("addNodes throws on an internal collision within the batch", () => {
		const map = new NodeMap();
		const batch = [{ name: "@blokjs/log" } as unknown as NodeBase, { name: "@blokjs/log" } as unknown as NodeBase];
		expect(() => map.addNodes(batch)).toThrow(/registration conflict/i);
	});

	it("{ replace: true } on a non-existent key just registers it (no throw, resolves)", () => {
		const map = new NodeMap();
		const fresh = stub("fresh");
		expect(() => map.addNode("brand-new", fresh, { replace: true })).not.toThrow();
		expect(map.getNode("brand-new")).toBe(fresh);
	});
});
