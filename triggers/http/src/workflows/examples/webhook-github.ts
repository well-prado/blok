import { node, step, subworkflow, switchOn, workflow } from "@blokjs/core";

export default workflow(
	"webhook-github",
	{
		version: "1.0.0",
		description:
			"GitHub webhook receiver. Trigger verifies X-Hub-Signature-256 (HMAC-SHA256 over rawBody) against GITHUB_WEBHOOK_SECRET. Routes by X-GitHub-Event header using a switch step — push events go to webhook-github-push, the pull-request family (pull_request, pull_request_review, pull_request_review_comment) to webhook-github-pr, the issue family (issues, issue_comment) to webhook-github-issues. Unknown events log + return 200 (GitHub retries non-2xx; don't want a retry storm). Needs `--triggers http,webhook --examples` at scaffold time and GITHUB_WEBHOOK_SECRET set in .env.local.",
		trigger: {
			webhook: {
				provider: "github",
				path: "/webhooks/github",
				secretEnv: "GITHUB_WEBHOOK_SECRET",
			},
		},
	},
	(event) => {
		switchOn(
			event.headers["x-github-event"],
			{
				cases: [
					{
						when: "push",
						do: () => {
							subworkflow("dispatch-push", "webhook-github-push", {
								repo: "js/(ctx.request.body.repository && ctx.request.body.repository.full_name) || null",
								ref: "js/ctx.request.body.ref || null",
								commits: "js/ctx.request.body.commits || []",
							});
						},
					},
					{
						when: ["pull_request", "pull_request_review", "pull_request_review_comment"],
						do: () => {
							subworkflow("dispatch-pr", "webhook-github-pr", {
								action: "js/ctx.request.body.action || null",
								pull_request: "js/ctx.request.body.pull_request || null",
								eventType: "js/ctx.request.headers['x-github-event']",
							});
						},
					},
					{
						when: ["issues", "issue_comment"],
						do: () => {
							subworkflow("dispatch-issues", "webhook-github-issues", {
								action: "js/ctx.request.body.action || null",
								issue: "js/ctx.request.body.issue || null",
								eventType: "js/ctx.request.headers['x-github-event']",
							});
						},
					},
				],
				default: () => {
					step("log-unknown", node("@blokjs/log"), {
						level: "warn",
						message:
							"js/`webhook-github: unknown event '${ctx.request.headers['x-github-event'] || ''}', returning 200`",
					});
				},
			},
			{ id: "route-by-event" },
		);
		step("respond", node("@blokjs/expr"), {
			expression:
				"((dispatchKey) => { const childResp = dispatchKey ? ctx.state[dispatchKey] : null; const childData = childResp && childResp.data ? childResp.data : childResp; return { received: true, eventType: ctx.request.headers['x-github-event'] || null, deliveryId: ctx.request.headers['x-github-delivery'] || null, dispatchedTo: dispatchKey || 'log-unknown', child: childData }; })(['dispatch-push', 'dispatch-pr', 'dispatch-issues'].find(k => ctx.state[k] !== undefined))",
		});
	},
);
