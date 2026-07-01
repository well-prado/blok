import { http, node, step, workflow } from "@blokjs/core";

export default workflow(
	"webhook-linear-comment",
	{
		version: "1.0.0",
		description:
			"Linear Comment event handler — dispatched from webhook-linear via sub-workflow. Real handlers would forward to Slack threads, sync to a discussion board, trigger AI summarization; this demo summarizes the comment.",
		trigger: http.post("/webhook-handlers/linear-comment", { accept: "application/json" }),
	},
	() => {
		step("respond", node("@blokjs/expr"), {
			expression:
				"({ handler: 'linear-comment', action: ctx.request.body.action || null, commentId: (ctx.request.body.data && ctx.request.body.data.id) || null, body: (ctx.request.body.data && ctx.request.body.data.body) || null, issueId: (ctx.request.body.data && ctx.request.body.data.issue && ctx.request.body.data.issue.id) || null })",
		});
	},
);
