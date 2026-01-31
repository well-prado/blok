import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNode } from "../../../src/commands/create/node";
import { setNonInteractive } from "../../../src/services/non-interactive.js";

describe("create node (non-interactive)", () => {
	beforeEach(() => {
		setNonInteractive(true);
	});

	afterEach(() => {
		setNonInteractive(false);
	});

	it("should not throw when name is provided in non-interactive mode", async () => {
		// In non-interactive mode with a name, createNode should resolve all prompts
		// via defaults and not hang waiting for interactive input
		expect(async () => await createNode({ name: "test-ni-node" })).not.toThrow();
	});

	it("should throw when name is missing in non-interactive mode", async () => {
		await expect(createNode({})).rejects.toThrow("Missing required flag --name (non-interactive mode)");
	});

	it("should accept runtime flag in non-interactive mode", async () => {
		expect(async () => await createNode({ name: "test-ni-runtime", runtime: "typescript" })).not.toThrow();
	});

	it("should accept node-type flag in non-interactive mode", async () => {
		expect(async () => await createNode({ name: "test-ni-type", nodeType: "module" })).not.toThrow();
	});

	it("should accept template flag in non-interactive mode", async () => {
		expect(async () => await createNode({ name: "test-ni-template", template: "standard" })).not.toThrow();
	});
});
