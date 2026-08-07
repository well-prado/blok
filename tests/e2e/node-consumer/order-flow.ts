/**
 * A typed-handle workflow, exactly as a consumer authors it (#688).
 *
 * `runWorkflow` takes this default export directly — including the promise
 * `workflow()` returns — so the test needs no JSON copy of the workflow and no
 * `await` at the import site.
 */
import { http, branch, gt, step, workflow } from "@blokjs/core";
import type { Handle } from "@blokjs/core";
import { chargeCard, flagVip, orderValidator } from "./order-nodes";

export default workflow("process-order", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
	// The HTTP entry handle types `body` as `unknown` — narrow it to the shape
	// this route accepts.
	const body = req.body as { id: Handle<string>; total: Handle<number> };

	const order = step("validate", orderValidator, { body });
	step("charge", chargeCard, { orderId: order.id, amount: order.total });
	branch("large-order", gt(order.total, 100), {
		then: () => {
			step("flag", flagVip, { id: order.id });
		},
	});
});
