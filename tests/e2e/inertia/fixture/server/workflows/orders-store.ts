/**
 * `POST /orders` — validate, then create or bounce back.
 *
 * `check` is the Precognition boundary: with `Precognition: true` on the
 * request the runner answers 204/422 from this step alone (scenario 30) and
 * nothing after it runs; without the header the same workflow performs the
 * real write.
 */
import { http, type Handle, branch, eq, step, workflow } from "@blokjs/core";
import { ValidateNode } from "@blokjs/helpers";
import { z } from "zod";
import { createOrder, rejectSubmission } from "#app/nodes/e2e/index";

export const OrderSchema = z.object({
	// TWO rules on `sku`, so `withAllErrors` has two messages to ship for one
	// field (scenario 29) instead of the single message Inertia ships by default.
	sku: z
		.string()
		.min(1, "Required.")
		.regex(/^[a-zA-Z0-9-]+$/, "Invalid format."),
	qty: z.coerce.number().min(1, "Must be at least 1."),
});

export default workflow("e2e-orders-store", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
	const body = req.body as Handle<z.infer<typeof OrderSchema>>;
	const checked = step(
		"check",
		ValidateNode,
		// EVERY message per field, so `withAllErrors` has something to ship
		// (scenario 29): `sku` fails two rules at once on an empty value.
		{ schema: OrderSchema, data: body, withAllErrors: true },
		{ precognition: true },
	);
	branch("route", eq(checked.ok, true), {
		then: () => {
			step("create", createOrder, { sku: body.sku, qty: body.qty });
		},
		else: () => {
			step("reject", rejectSubmission, { errors: checked.errors, fallback: "/orders/create" });
		},
	});
});
