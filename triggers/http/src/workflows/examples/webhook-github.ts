import { switchOn, workflow } from "@blokjs/helper";

export default workflow({
	name: "webhook-github",
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
	steps: [
		switchOn({
			id: "route-by-event",
			on: "js/(ctx.request.headers['x-github-event'] || 'unknown').toLowerCase()",
			cases: [
				{
					when: "push",
					do: [
						{
							id: "dispatch-push",
							subworkflow: "webhook-github-push",
							inputs: {
								repo: "js/(ctx.request.body.repository && ctx.request.body.repository.full_name) || null",
								ref: "js/ctx.request.body.ref || null",
								commits: "js/ctx.request.body.commits || []",
							},
						},
					],
				},
				{
					when: ["pull_request", "pull_request_review", "pull_request_review_comment"],
					do: [
						{
							id: "dispatch-pr",
							subworkflow: "webhook-github-pr",
							inputs: {
								action: "js/ctx.request.body.action || null",
								pull_request: "js/ctx.request.body.pull_request || null",
								eventType: "js/ctx.request.headers['x-github-event']",
							},
						},
					],
				},
				{
					when: ["issues", "issue_comment"],
					do: [
						{
							id: "dispatch-issues",
							subworkflow: "webhook-github-issues",
							inputs: {
								action: "js/ctx.request.body.action || null",
								issue: "js/ctx.request.body.issue || null",
								eventType: "js/ctx.request.headers['x-github-event']",
							},
						},
					],
				},
			],
			default: [
				{
					id: "log-unknown",
					use: "@blokjs/log",
					type: "module",
					inputs: {
						level: "warn",
						message:
							"js/`webhook-github: unknown event '${ctx.request.headers['x-github-event'] || ''}', returning 200`",
					},
				},
			],
		}),
		{
			id: "respond",
			use: "@blokjs/expr",
			type: "module",
			inputs: {
				expression:
					"((dispatchKey) => { const childResp = dispatchKey ? ctx.state[dispatchKey] : null; const childData = childResp && childResp.data ? childResp.data : childResp; return { received: true, eventType: ctx.request.headers['x-github-event'] || null, deliveryId: ctx.request.headers['x-github-delivery'] || null, dispatchedTo: dispatchKey || 'log-unknown', child: childData }; })(['dispatch-push', 'dispatch-pr', 'dispatch-issues'].find(k => ctx.state[k] !== undefined))",
			},
		},
	],
});
