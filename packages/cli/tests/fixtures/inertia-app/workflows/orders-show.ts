import { http, workflow } from "@blokjs/core";
import { definePage, once, scroll } from "@blokjs/inertia";
import { orderDetail, orderEvents, orderForm } from "../nodes.js";

export const OrdersShow = definePage("Orders/Show", {
	order: orderDetail,
	events: scroll(orderEvents, { wrapper: "data" }),
	form: once(orderForm),
});

export default workflow("orders.show", { version: "1.0.0", trigger: http.get("/orders/:id") }, (req) => {
	OrdersShow.render(req, "page", "/orders/:id", {});
});
