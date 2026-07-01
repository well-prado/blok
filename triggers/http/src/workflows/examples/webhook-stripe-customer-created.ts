import { http, node, step, workflow } from "@blokjs/core";

export default workflow(
	"stripe.customer.created",
	{
		version: "1.0.0",
		description:
			"Stripe customer.created event handler — dispatched from webhook-stripe via polymorphic sub-workflow lookup. Real handlers would CRM-sync the customer, fire a welcome email, provision tenant resources; this demo summarizes the new customer.",
		trigger: http.post("/webhook-handlers/stripe.customer.created", {
			accept: "application/json",
		}),
	},
	() => {
		step("respond", node("@blokjs/expr"), {
			expression:
				"({ handler: 'stripe.customer.created', customerId: ctx.request.body?.stripeEvent?.data?.object?.id ?? null, email: ctx.request.body?.stripeEvent?.data?.object?.email ?? null })",
		});
	},
);
