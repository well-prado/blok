import { workflow } from "@blokjs/helper";

export default workflow({
	name: "stripe.customer.created",
	version: "1.0.0",
	description:
		"Stripe customer.created event handler — dispatched from webhook-stripe via polymorphic sub-workflow lookup. Real handlers would CRM-sync the customer, fire a welcome email, provision tenant resources; this demo summarizes the new customer.",
	trigger: {
		http: {
			method: "POST",
			path: "/webhook-handlers/stripe.customer.created",
			accept: "application/json",
		},
	},
	steps: [
		{
			id: "respond",
			use: "@blokjs/expr",
			type: "module",
			inputs: {
				expression:
					"({ handler: 'stripe.customer.created', customerId: ctx.request.body?.stripeEvent?.data?.object?.id ?? null, email: ctx.request.body?.stripeEvent?.data?.object?.email ?? null })",
			},
		},
	],
});
