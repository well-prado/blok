import { http, js, node, step, workflow } from "@blokjs/core";

export default workflow(
	"stripe.invoice.paid",
	{
		version: "1.0.0",
		description:
			"Stripe invoice.paid event handler — dispatched from webhook-stripe via polymorphic sub-workflow lookup (namespace=stripe + body.type=invoice.paid → stripe.invoice.paid). Parent passes the verified event through inputs.stripeEvent, which lands here as ctx.request.body.stripeEvent. Real handlers would record the payment, fire a receipt email, kick a fulfillment job; this demo logs to the run trace + returns a structured summary.",
		trigger: http.post("/webhook-handlers/stripe.invoice.paid", {
			accept: "application/json",
		}),
	},
	(req) => {
		step(
			"log",
			node("@blokjs/log"),
			{
				level: "info",
				message: js`\`stripe.invoice.paid: invoice=\${${req.body}?.stripeEvent?.data?.object?.id ?? '?'} amount=\${${req.body}?.stripeEvent?.data?.object?.amount_paid ?? '?'}\``,
			},
			{ ephemeral: true },
		);
		step("respond", node("@blokjs/expr"), {
			expression:
				"({ handler: 'stripe.invoice.paid', invoiceId: ctx.request.body?.stripeEvent?.data?.object?.id ?? null, amountPaid: ctx.request.body?.stripeEvent?.data?.object?.amount_paid ?? null, customer: ctx.request.body?.stripeEvent?.data?.object?.customer ?? null })",
		});
	},
);
