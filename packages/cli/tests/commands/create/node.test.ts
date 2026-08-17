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
 * awaiting the promise pins down is therefore exactly that: the call SETTLES
 * rather than hanging on an interactive prompt.
 *
 * It settles two ways depending on the machine, and both are correct: on a box
 * with ~/.blok/blok cloned it resolves having written nothing, while on a clean
 * runner `node.ts`'s first guard rejects with "blok repository was not found".
 * Asserting `resolves` pinned the developer-box outcome and turned CI red once
 * #899 made `createNode` rethrow instead of swallowing. The failure paths are
 * covered by node-non-interactive.test.ts, the generated-node substance by the
 * deterministic template tests in this directory (php-node-template,
 * ruby-node-scaffold, …) and tests/e2e/scaffold-smoke.
 */
test("create node settles without prompting, on any machine", async () => {
	const outcome = await createNode({ name: "default-node" }).then(
		() => "resolved",
		(err: unknown) => (err as Error).message,
	);

	expect(outcome).toMatch(/^resolved$|blok repository was not found|haven't created a project yet/);
});
