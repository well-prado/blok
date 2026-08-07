/**
 * Recipe 2 — test the workflow itself: real nodes, one mocked side effect (#688).
 *
 * This is the layer the field report could not reach ("node sequencing itself
 * remains untested"). The assertions here are about WIRING — which step got
 * which resolved inputs, which arm ran, what landed in state — not about the
 * business logic each node already unit-tests.
 */
import { runWorkflow } from "@blokjs/core/testing";
import orderFlow from "./order-flow";
import { describe, expect, it } from "./test-runner";

/** `charge-card` throws if it is ever really invoked, so this mock is load-bearing. */
const chargeOk = { "charge-card": async () => ({ receipt: "rc_123" }) };

describe("process-order", () => {
	it("passes resolved inputs from step to step", async () => {
		const run = await runWorkflow(orderFlow, { id: "o-1", total: 120 }, { mock: chargeOk });

		expect(run.ok).toBe(true);
		expect(run.state("validate")).toEqual({ id: "o-1", total: 120 });
		// The handle reads `order.id` / `order.total` resolved against real state.
		expect(run.step("charge")?.inputs).toEqual({ orderId: "o-1", amount: 120 });
		expect(run.state("charge")).toEqual({ receipt: "rc_123" });
		expect(run.response).toEqual({ vip: true });
	});

	it("skips the branch arm a small order does not take", async () => {
		const run = await runWorkflow(orderFlow, { id: "o-2", total: 10 }, { mock: chargeOk });

		expect(run.ok).toBe(true);
		expect(run.step("charge")?.executed).toBe(true);
		expect(run.step("flag")?.executed).toBe(false);
		expect(run.state("flag")).toBeUndefined();
	});

	it("fails when a mock returns a field the node's output schema never declares", async () => {
		await expect(
			runWorkflow(
				orderFlow,
				{ id: "o-3", total: 10 },
				{ mock: { "charge-card": async () => ({ receipt: "rc_1", chargedAt: null }) } },
			),
		).rejects.toThrow(/charge-card[\s\S]*chargedAt/);
	});
});
