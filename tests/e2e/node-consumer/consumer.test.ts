/**
 * The downstream-consumer acceptance test for #687.
 *
 * Runs under vitest on Node — NOT Bun — against the packed `@blokjs/*`
 * tarballs, with an empty `vitest.config.ts`. Every import below goes through
 * Node's native ESM loader, so an extensionless relative specifier anywhere in
 * the dependency graph fails this file with `ERR_MODULE_NOT_FOUND`.
 *
 * Keep it trivial. It is a packaging probe, not a feature test — the real DSL
 * and harness coverage lives in the monorepo.
 */
import { http, defineNode, step, workflow } from "@blokjs/core";
import { NodeTestHarness } from "@blokjs/core/testing";
import { Runner } from "@blokjs/runner";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const greet = defineNode({
	name: "greet",
	description: "Greets whoever is passed in.",
	input: z.object({ who: z.string() }),
	output: z.object({ message: z.string() }),
	execute: (_ctx, input) => ({ message: `hello ${input.who}` }),
});

describe("@blokjs packages load under Node's ESM loader", () => {
	it("exposes the authoring surface, the harness, and the engine", () => {
		expect(typeof workflow).toBe("function");
		expect(typeof step).toBe("function");
		expect(typeof http.post).toBe("function");
		expect(typeof NodeTestHarness).toBe("function");
		expect(typeof Runner).toBe("function");
	});

	it("runs a node through the published test harness", async () => {
		const harness = new NodeTestHarness(greet);
		const result = await harness.execute({ who: "node" });
		expect(result.success).toBe(true);
		expect(result.data).toEqual({ message: "hello node" });
	});
});
