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
});
