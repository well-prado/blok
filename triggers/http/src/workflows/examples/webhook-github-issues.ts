import { workflow } from "@blokjs/helper";

export default workflow({
	name: "webhook-github-issues",
	version: "1.0.0",
	description:
		"GitHub issues family handler (issues, issue_comment) — dispatched from webhook-github via sub-workflow. Same grouping pattern as the PR family handler.",
	trigger: {
		http: {
			method: "POST",
			path: "/webhook-handlers/github-issues",
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
					"({ handler: 'github-issues', eventType: ctx.request.body.eventType || null, action: ctx.request.body.action || null, issueNumber: (ctx.request.body.issue && ctx.request.body.issue.number) || null, title: (ctx.request.body.issue && ctx.request.body.issue.title) || null })",
			},
		},
	],
});
