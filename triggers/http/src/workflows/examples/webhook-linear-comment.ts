import { workflow } from "@blokjs/helper";

export default workflow({
	name: "webhook-linear-comment",
	version: "1.0.0",
	description:
		"Linear Comment event handler — dispatched from webhook-linear via sub-workflow. Real handlers would forward to Slack threads, sync to a discussion board, trigger AI summarization; this demo summarizes the comment.",
	trigger: {
		http: {
			method: "POST",
			path: "/webhook-handlers/linear-comment",
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
					"({ handler: 'linear-comment', action: ctx.request.body.action || null, commentId: (ctx.request.body.data && ctx.request.body.data.id) || null, body: (ctx.request.body.data && ctx.request.body.data.body) || null, issueId: (ctx.request.body.data && ctx.request.body.data.issue && ctx.request.body.data.issue.id) || null })",
			},
		},
	],
});
