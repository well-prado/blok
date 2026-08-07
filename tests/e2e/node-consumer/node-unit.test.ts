/**
 * Recipe 1 — unit-test one node in isolation (#688).
 *
 * This file is also the cold-start budget: it imports the authoring surface and
 * the testing surface and nothing else, so a `vitest run node-unit.test.ts`
 * measures what a consumer pays to test a single node. No server, no Docker, no
 * gRPC, no proto parse.
 */
import { runNode } from "@blokjs/core/testing";
import { orderValidator } from "./order-nodes";
import { describe, expect, it } from "./test-runner";

describe("order-validator", () => {
	it("normalizes the incoming order", async () => {
		const out = await runNode(orderValidator, { body: { id: "o-1", total: 120 } });

		expect(out).toEqual({ id: "o-1", total: 120 });
	});

	it("rejects a payload its input schema does not accept", async () => {
		await expect(runNode(orderValidator, { body: { id: "o-1" } } as never)).rejects.toThrow(/total/);
	});
});
