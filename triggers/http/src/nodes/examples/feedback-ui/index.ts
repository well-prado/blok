import fs from "node:fs";
import path from "node:path";
import { defineNode } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import ejs from "ejs";
import { z } from "zod";

const rootDir = path.resolve(__dirname, ".");

function root(relPath: string): string {
	return path.resolve(rootDir, relPath);
}

export default defineNode({
	name: "feedback-ui",
	description: "Renders the feedback UI from an EJS template",
	contentType: "text/html",

	input: z.object({}),

	output: z.string(),

	async execute(ctx: Context, input) {
		const content = fs.readFileSync(root("index.html"), "utf8");
		const render = ejs.compile(content, { client: false });
		const ctxCloned = {
			config: ctx.config,
			inputs: input,
			response: ctx.response,
			request: {
				body: ctx.request.body,
				headers: ctx.request.headers,
				url: ctx.request.url,
				originalUrl: ctx.request.originalUrl,
				query: ctx.request.query,
				params: ctx.request.params,
				cookies: ctx.request.cookies,
			},
		};

		return render({ ctx: btoa(JSON.stringify(ctxCloned)) });
	},
});
