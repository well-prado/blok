import { workflow } from "@blokjs/helper";

export default workflow({
	name: "webhook-linear-issue",
	version: "1.0.0",
	description:
		"Linear Issue event handler — dispatched from webhook-linear via sub-workflow. Linear sends `action: 'create' | 'update' | 'remove'` describing the issue state transition. Real handlers would sync to Jira/Notion, trigger CI on label changes, post to Slack; this demo summarizes the issue change.",
	trigger: {
		http: {
			method: "POST",
			path: "/webhook-handlers/linear-issue",
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
					"({ handler: 'linear-issue', action: ctx.request.body.action || null, issueId: (ctx.request.body.data && ctx.request.body.data.id) || null, title: (ctx.request.body.data && ctx.request.body.data.title) || null, state: (ctx.request.body.data && ctx.request.body.data.state && ctx.request.body.data.state.name) || null, url: ctx.request.body.url || null })",
			},
		},
	],
});
