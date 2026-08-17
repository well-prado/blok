import { expect, test } from "vitest";
import { createNode } from "../../../src/commands/create/node";

/**
 * Deliberately bounded. `createNode` has no `--local` seam: it copies templates
 * out of ~/.blok/blok and requires the cwd to be a scaffolded project
 * (`src/nodes`), which does not hold when vitest runs from packages/cli.
 *
 * With `--name` but WITHOUT non-interactive mode, no runtime default is applied
 * (that only happens on the non-interactive branch), so every runtime arm is
 * skipped and the call falls through to the end having written nothing. What
 * awaiting the promise pins down is therefore exactly that: the call settles
 * rather than hanging on an interactive prompt, and this flag-only path does
 * not reject. The failure paths are covered by node-non-interactive.test.ts,
 * the generated-node substance by the deterministic template tests in this
 * directory (php-node-template, ruby-node-scaffold, …) and tests/e2e/scaffold-smoke.
 */
test("create node", async () => {
	await expect(createNode({ name: "default-node" })).resolves.toBeUndefined();
});
