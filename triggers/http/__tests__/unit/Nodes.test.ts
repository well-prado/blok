import { describe, expect, it } from "vitest";
import nodes from "../../src/Nodes";

describe("Nodes", () => {
	it("should export an object with node keys", () => {
		expect(typeof nodes).toBe("object");
	});

	it("should have @nanoservice-ts/api-call key", () => {
		expect(nodes["@nanoservice-ts/api-call"]).toBeDefined();
	});

	it("should have @nanoservice-ts/if-else key", () => {
		expect(nodes["@nanoservice-ts/if-else"]).toBeDefined();
	});
});
