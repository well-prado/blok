import { http, workflow } from "@blokjs/core";
import { always, defer, definePage, optional } from "@blokjs/inertia";
import { currentUser, heavyStats, legacyStats, listOrders, loadFilters, orderStatus } from "../nodes.js";

export const OrdersIndex = definePage("Orders/Index", {
	auth: always(currentUser),
	orders: listOrders,
	status: orderStatus,
	filters: optional(loadFilters),
	stats: defer(heavyStats, { group: "dashboard", rescue: true }),
	legacy: legacyStats,
});

export default workflow("orders.index", { version: "1.0.0", trigger: http.get("/orders") }, (req) => {
	OrdersIndex.render(req, "page", "/orders", {});
});
