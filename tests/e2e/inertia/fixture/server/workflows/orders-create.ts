/** `GET /orders/create` — the form page behind scenarios 5, 6, 11, 27-32 and 40. */
import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";
import { currentUser } from "#app/nodes/e2e/index";

export const OrdersCreate = definePage("Orders/Create", {
	auth: always(currentUser),
});

export default workflow("e2e-orders-create", { version: "1.0.0", trigger: http.get("/orders/create") }, (req) => {
	// `withAllErrors` ships EVERY message per field (scenario 29) — the client
	// renders `errors.sku` as an array, which is what the option is for.
	OrdersCreate.render(req, "page", "/orders/create", {}, { viewData: { title: "New order" }, withAllErrors: true });
});
