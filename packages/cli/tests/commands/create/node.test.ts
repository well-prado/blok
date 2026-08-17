import { expect, test } from "vitest";
import { createNode } from "../../../src/commands/create/node";

/**
 * Deliberately bounded. Unlike createProject, `createNode` swallows every
 * failure in its own catch WITHOUT even setting an exit code (see the end of
 * src/commands/create/node.ts), and it has no `--local` seam: it copies
 * templates out of ~/.blok/blok and requires the cwd to be a scaffolded
 * project (`src/nodes`). Neither holds when vitest runs from packages/cli, so
 * there is no observable outcome left to assert here.
 *
 * What awaiting the promise DOES pin down: the call settles rather than
 * hanging on an interactive prompt, and it does not reject. The generated-node
 * substance is covered by the deterministic template tests in this directory
 * (php-node-template, ruby-node-scaffold, …) and by tests/e2e/scaffold-smoke.
 */
test("create node", async () => {
	await expect(createNode({ name: "default-node" })).resolves.toBeUndefined();
});
