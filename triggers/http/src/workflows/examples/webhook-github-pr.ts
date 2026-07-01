import { http, node, step, workflow } from "@blokjs/core";

export default workflow(
	"webhook-github-pr",
	{
		version: "1.0.0",
		description:
			"GitHub pull-request family handler (pull_request, pull_request_review, pull_request_review_comment) — dispatched from webhook-github via sub-workflow. The router groups the whole family under one handler via switch-case array `when`. Real deployments would update review state, post status checks, run lint/preview pipelines.",
		trigger: http.post("/webhook-handlers/github-pr", {
			accept: "application/json",
		}),
	},
	() => {
		step("respond", node("@blokjs/expr"), {
			expression:
				"({ handler: 'github-pr', eventType: ctx.request.body.eventType || null, action: ctx.request.body.action || null, prNumber: (ctx.request.body.pull_request && ctx.request.body.pull_request.number) || null, title: (ctx.request.body.pull_request && ctx.request.body.pull_request.title) || null })",
		});
	},
);
