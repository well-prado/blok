/**
 * The form page and its submit.
 *
 * `check` is marked `{ precognition: true }`, so Inertia's live validation gets
 * a 204/422 from that step alone and NOTHING after it runs — the real submit
 * goes through the same workflow, header-free.
 */

import { http, branch, eq, step, workflow } from "@blokjs/core";
import { ValidateNode } from "@blokjs/helpers";
import { definePage } from "@blokjs/inertia";
import { z } from "zod";
import { createOrder, rejectOrder } from "../nodes.js";

export const OrderSchema = z.object({
	sku: z.string().min(1, "Required."),
	total: z.number().min(1, "Must be at least 1."),
});

export const OrdersCreate = definePage("Orders/Create", {});

export const page = workflow(
	"orders-create-page",
	{ version: "1.0.0", trigger: http.get("/orders/new", { middleware: ["inertia.shared"] }) },
	(req) => {
		OrdersCreate.render(req, "page", "/orders/new", {});
	},
);

export default workflow(
	"orders-create",
	{ version: "1.0.0", trigger: http.post("/orders", { middleware: ["inertia.shared"] }) },
	(req) => {
		const checked = step("check", ValidateNode, { schema: OrderSchema, data: req.body }, { precognition: true });
		branch("route", eq(checked.ok, true), {
			then: () => {
				step("create", createOrder, { sku: req.body.sku, total: req.body.total });
			},
			else: () => {
				step("reject", rejectOrder, { errors: checked.errors });
			},
		});
	},
);
