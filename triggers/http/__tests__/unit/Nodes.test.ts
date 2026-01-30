import { describe, expect, it } from "vitest";
import nodes from "../../src/Nodes";

describe("Nodes", () => {
	it("should export an object with node keys", () => {
		expect(typeof nodes).toBe("object");
	});

	it("should have @blok/api-call key", () => {
		expect(nodes["@blok/api-call"]).toBeDefined();
	});

	it("should have @blok/if-else key", () => {
		expect(nodes["@blok/if-else"]).toBeDefined();
	});
});
