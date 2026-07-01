import { http, node, step, workflow } from "@blokjs/core";

export default workflow(
	"webhook-github-issues",
	{
		version: "1.0.0",
		description:
			"GitHub issues family handler (issues, issue_comment) — dispatched from webhook-github via sub-workflow. Same grouping pattern as the PR family handler.",
		trigger: http.post("/webhook-handlers/github-issues", {
			accept: "application/json",
		}),
	},
	() => {
		step("respond", node("@blokjs/expr"), {
			expression:
				"({ handler: 'github-issues', eventType: ctx.request.body.eventType || null, action: ctx.request.body.action || null, issueNumber: (ctx.request.body.issue && ctx.request.body.issue.number) || null, title: (ctx.request.body.issue && ctx.request.body.issue.title) || null })",
		});
	},
);
