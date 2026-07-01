import { http, js, node, step, workflow } from "@blokjs/core";
import type { Handle } from "@blokjs/core";

export default workflow(
	"webhook-github-push",
	{
		version: "1.0.0",
		description:
			"GitHub push event handler — dispatched from webhook-github via sub-workflow. Real deployments would kick a CI build, post to Slack, update a deployment dashboard; this demo logs + summarizes the push.",
		trigger: http.post("/webhook-handlers/github-push", {
			accept: "application/json",
		}),
	},
	(req) => {
		const body = req.body as Handle<{ repo: string; ref: string; commits: unknown[] }>;
		step(
			"log",
			node("@blokjs/log"),
			{
				level: "info",
				message: js`github-push: ${body.repo || "?"} ${body.ref || "?"} (${Array.isArray(body.commits) ? body.commits.length : 0} commits)`,
			},
			{ ephemeral: true },
		);
		step("respond", node("@blokjs/expr"), {
			expression:
				"({ handler: 'github-push', repo: ctx.request.body.repo || null, ref: ctx.request.body.ref || null, commits: Array.isArray(ctx.request.body.commits) ? ctx.request.body.commits.length : 0 })",
		});
	},
);
