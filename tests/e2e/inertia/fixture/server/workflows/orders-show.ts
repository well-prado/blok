/** `GET /orders/:id` — the detail page scenario 4 navigates to and comes back from. */
import { http, tpl, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";
import { currentUser, showOrder } from "#app/nodes/e2e/index";

export const OrderShow = definePage("Orders/Show", {
	auth: always(currentUser),
	order: showOrder,
});

export default workflow("e2e-order-show", { version: "1.0.0", trigger: http.get("/orders/:id") }, (req) => {
	OrderShow.render(
		req,
		"page",
		tpl`/orders/${req.params.id}`,
		{ order: { id: req.params.id } },
		{ viewData: { title: "Order" } },
	);
});
