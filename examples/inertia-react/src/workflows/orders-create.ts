/**
 * The form page and its submit.
 *
 * `check` is marked `{ precognition: true }`, so Inertia's live validation gets
 * a 204/422 from that step alone and NOTHING after it runs — the real submit
 * goes through the same workflow, header-free.
 */

import { type Handle, branch, eq, http, step, workflow } from "@blokjs/core";
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
		// An HTTP body is `unknown` on the entry handle — the schema above is what
		// actually validates it, so this cast only names the shape for the reads.
		const body = req.body as Handle<z.infer<typeof OrderSchema>>;
		const checked = step("check", ValidateNode, { schema: OrderSchema, data: body }, { precognition: true });
		branch("route", eq(checked.ok, true), {
			then: () => {
				step("create", createOrder, { sku: body.sku, total: body.total });
			},
			else: () => {
				step("reject", rejectOrder, { errors: checked.errors });
			},
		});
	},
);
