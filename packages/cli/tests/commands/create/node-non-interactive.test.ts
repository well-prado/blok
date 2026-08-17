import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNode } from "../../../src/commands/create/node";
import { setNonInteractive } from "../../../src/services/non-interactive.js";

/**
 * Deliberately bounded. Unlike createProject, `createNode` swallows every
 * failure in its own catch WITHOUT even setting an exit code (see the end of
 * src/commands/create/node.ts), and it has no `--local` seam: it copies
 * templates out of ~/.blok/blok and requires the cwd to be a scaffolded
 * project (`src/nodes`). Neither holds when vitest runs from packages/cli, so
 * there is no observable outcome left to assert here.
 *
 * What awaiting the promise DOES pin down: each flag combination settles
 * rather than hanging on an interactive prompt, and none of them rejects. The
 * generated-node substance is covered by the deterministic template tests in
 * this directory (php-node-template, ruby-node-scaffold, …) and by
 * tests/e2e/scaffold-smoke.
 */
describe("create node (non-interactive)", () => {
	beforeEach(() => {
		setNonInteractive(true);
	});

	afterEach(() => {
		setNonInteractive(false);
	});

	it("should not throw when name is provided in non-interactive mode", async () => {
		await expect(createNode({ name: "test-ni-node" })).resolves.toBeUndefined();
	});

	it("should throw when name is missing in non-interactive mode", async () => {
		await expect(createNode({})).rejects.toThrow("Missing required flag --name (non-interactive mode)");
	});

	it("should accept runtime flag in non-interactive mode", async () => {
		await expect(createNode({ name: "test-ni-runtime", runtime: "typescript" })).resolves.toBeUndefined();
	});

	it("should accept node-type flag in non-interactive mode", async () => {
		await expect(createNode({ name: "test-ni-type", nodeType: "module" })).resolves.toBeUndefined();
	});

	it("should accept template flag in non-interactive mode", async () => {
		await expect(createNode({ name: "test-ni-template", template: "standard" })).resolves.toBeUndefined();
	});
});
