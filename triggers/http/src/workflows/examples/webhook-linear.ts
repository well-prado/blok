import { type Handle, js, node, step, subworkflow, switchOn, workflow } from "@blokjs/core";

/**
 * Linear webhook receiver — now authored with the @blokjs/core typed-handle DSL.
 * It used to stay object-style because `switchOn` needed a COMPUTED discriminant
 * (case-fold Linear's capitalized `type`) that no bare handle could express; the
 * `js\`…\`` discriminant escape (#647) closes that gap.
 */
export default workflow(
	"webhook-linear",
	{
		version: "1.0.0",
		description:
			"Linear webhook receiver. Linear isn't a built-in webhook provider, so we use the trigger's CUSTOM signature config: HMAC-SHA256 over the raw body, hex digest, in the `Linear-Signature` header. This pattern works for ANY HMAC-signed webhook — point `header` + `format` at the right values. After verification, switches on body.type (Linear sends `type: 'Issue' | 'Comment' | 'Project' | ...`) to per-type handlers. Needs `--triggers http,webhook --examples` at scaffold time and LINEAR_WEBHOOK_SECRET set in .env.local.",
		trigger: {
			webhook: {
				path: "/webhooks/linear",
				signature: {
					scheme: "hmac-sha256",
					header: "Linear-Signature",
					format: "{hex}",
					secretEnv: "LINEAR_WEBHOOK_SECRET",
					// No timestampHeader → the replay-tolerance window is unused; omit
					// it (the callback-form workflow() validates `tolerance` as a
					// positive int, so the old inert `tolerance: 0` is dropped).
				},
			},
		},
	},
	(event) => {
		const body = event.body as Handle<{ type?: string; action?: unknown; data?: unknown; url?: unknown }>;

		// Linear sends a capitalized `type` ("Issue" | "Comment" | …); the case
		// labels are lowercase. A bare handle carries the raw value and can't
		// case-fold or default it — so route on a js`…` computed discriminant.
		switchOn(
			js`(${body.type} || 'unknown').toLowerCase()`,
			{
				cases: [
					{
						when: "issue",
						do: () => {
							subworkflow("dispatch-issue", "webhook-linear-issue", {
								action: js`${body.action} || null`,
								data: js`${body.data} || null`,
								url: js`${body.url} || null`,
							});
						},
					},
					{
						when: "comment",
						do: () => {
							subworkflow("dispatch-comment", "webhook-linear-comment", {
								action: js`${body.action} || null`,
								data: js`${body.data} || null`,
								url: js`${body.url} || null`,
							});
						},
					},
				],
				default: () => {
					step(
						"log-unknown",
						node("@blokjs/log"),
						{
							level: "warn",
							message: js`'webhook-linear: unhandled type ' + (${body.type} || '') + ' action=' + (${body.action} || '')`,
						},
						{ ephemeral: true },
					);
				},
			},
			{ id: "route-by-type" },
		);

		step("respond", node("@blokjs/expr"), {
			expression:
				"((dispatchKey) => { const childResp = dispatchKey ? ctx.state[dispatchKey] : null; const childData = childResp && childResp.data ? childResp.data : childResp; return { received: true, type: ctx.request.body.type || null, action: ctx.request.body.action || null, dispatchedTo: dispatchKey || 'log-unknown', child: childData }; })(['dispatch-issue', 'dispatch-comment'].find(k => ctx.state[k] !== undefined))",
		});
	},
);
