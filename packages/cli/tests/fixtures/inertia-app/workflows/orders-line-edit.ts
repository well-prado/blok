import { http, workflow } from "@blokjs/core";
import { definePage, merge } from "@blokjs/inertia";
import { orderDetail, orderEvents } from "../nodes.js";

export const OrdersLineEdit = definePage("Orders/LineEdit", {
	order: orderDetail,
	events: merge(orderEvents, { append: "data" }),
});

export default workflow(
	"orders.line-edit",
	{ version: "1.0.0", trigger: http.post("/orders/:id/lines/:lineId") },
	(req) => {
		OrdersLineEdit.render(req, "page", "/orders/:id/lines/:lineId", {});
	},
);
