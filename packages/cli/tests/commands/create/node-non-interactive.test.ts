import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNode } from "../../../src/commands/create/node";
import { setNonInteractive } from "../../../src/services/non-interactive.js";

/**
 * Deliberately bounded. `createNode` has no `--local` seam: it copies templates
 * out of ~/.blok/blok and requires the cwd to be a scaffolded project
 * (`src/nodes`), which does not hold when vitest runs from packages/cli. So the
 * scaffold itself is never reached here — the generated-node substance is
 * covered by the deterministic template tests in this directory
 * (php-node-template, ruby-node-scaffold, …) and by tests/e2e/scaffold-smoke.
 *
 * What IS observable, and what these tests pin down: each flag combination
 * resolves its flags rather than hanging on an interactive prompt, and the
 * subsequent failure is REPORTED — since #899 `createNode` rethrows instead of
 * swallowing into a bare `process.exitCode`, so "the wrong project directory"
 * is distinguishable from "it worked". Asserting `resolves` here (as this file
 * used to) passed no matter what the function did with the error.
 */
/**
 * `createNode` has TWO "you are not in a project" guards, and WHICH one fires
 * depends on the machine: `node.ts` throws "blok repository was not found" when
 * ~/.blok/blok is absent (a clean CI runner), and the `ops1` → "haven't created
 * a project yet" message when that clone exists but the cwd has no `src/` (a
 * developer's box). Both mean the same thing here, so match either — pinning
 * one message made this suite pass locally and fail in CI.
 */
const NOT_A_PROJECT = /haven't created a project yet|blok repository was not found/;

describe("create node (non-interactive)", () => {
	beforeEach(() => {
		setNonInteractive(true);
	});

	afterEach(() => {
		setNonInteractive(false);
	});

	it("resolves the name flag, then fails on the missing project (not on a prompt)", async () => {
		await expect(createNode({ name: "test-ni-node" })).rejects.toThrow(NOT_A_PROJECT);
	});

	it("should throw when name is missing in non-interactive mode", async () => {
		await expect(createNode({})).rejects.toThrow("Missing required flag --name (non-interactive mode)");
	});

	it("should accept runtime flag in non-interactive mode", async () => {
		await expect(createNode({ name: "test-ni-runtime", runtime: "typescript" })).rejects.toThrow(NOT_A_PROJECT);
	});

	it("should accept node-type flag in non-interactive mode", async () => {
		await expect(createNode({ name: "test-ni-type", nodeType: "module" })).rejects.toThrow(NOT_A_PROJECT);
	});

	it("should accept template flag in non-interactive mode", async () => {
		await expect(createNode({ name: "test-ni-template", template: "standard" })).rejects.toThrow(NOT_A_PROJECT);
	});
});
