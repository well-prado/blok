/** `DELETE /orders/:id` — scenario 7 asserts the method on the request and 303 on the response. */
import { http, step, workflow } from "@blokjs/core";
import { deleteOrder } from "#app/nodes/e2e/index";

export default workflow("e2e-orders-destroy", { version: "1.0.0", trigger: http.delete("/orders/:id") }, (req) => {
	step("destroy", deleteOrder, { id: req.params.id });
});
