import { describe, expect, it } from "vitest";
import nodes from "../../src/Nodes";

describe("Nodes", () => {
	it("should export an object with node keys", () => {
		expect(typeof nodes).toBe("object");
	});

	it("should have @blokjs/api-call key", () => {
		expect(nodes["@blokjs/api-call"]).toBeDefined();
	});

	it("should have @blokjs/if-else key", () => {
		expect(nodes["@blokjs/if-else"]).toBeDefined();
	});
});
