import { workflow } from "@blokjs/helper";

export default workflow({
	name: "agent-tool-calculator",
	version: "1.0.0",
	description:
		"v0.6.10 — Demo tool endpoint: arithmetic evaluator. The agent POSTs `{ args: { expression: '17 * 23' } }`; we eval it and return the numeric result. SAFETY: this evals user-supplied input in a server-side `new Function` sandbox — fine for a localhost demo, but DO NOT expose this URL to untrusted callers in production. Real deployments should plumb the expression through a safe arithmetic parser (e.g. mathjs).",
	trigger: {
		http: {
			method: "POST",
			path: "/tools/calculator",
			accept: "application/json",
		},
	},
	steps: [
		{
			id: "calc",
			use: "@blokjs/expr",
			type: "module",
			inputs: {
				expression:
					"(() => { const expr = (ctx.request.body && ctx.request.body.args && ctx.request.body.args.expression) || '0'; try { const result = Function('\"use strict\"; return (' + expr + ')')(); return { expression: expr, result: result, ok: true }; } catch (err) { return { expression: expr, error: String(err), ok: false }; } })()",
			},
		},
	],
});
