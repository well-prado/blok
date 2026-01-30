import fs from "node:fs";
import path from "node:path";
import { defineNode } from "@blok/runner";
import type { Context } from "@blok/shared";
import ejs from "ejs";
import { z } from "zod";

const rootDir = path.resolve(__dirname, ".");

function root(relPath: string): string {
	return path.resolve(rootDir, relPath);
}

export default defineNode({
	name: "weather-ui",
	description: "Renders the weather/mastra agent UI with React script injection",
	contentType: "text/html",

	input: z.object({
		file_path: z.string().optional().default("./app/index.js"),
		view_path: z.string().optional().default("index.html"),
		title: z.string().optional().default(""),
	}),

	output: z.string(),

	async execute(ctx: Context, input) {
		let file_path = input.file_path;
		if (file_path === undefined || file_path === "") file_path = "./app/index.js";
		const react_script_template = '<script type="text/babel">REACT_SCRIPT</script>';

		const view_path = input.view_path || "index.html";
		const title = input.title;

		// Load React script from the current module location
		const min_file = root(file_path);
		let react_script = fs.readFileSync(min_file, "utf8");
		react_script = react_script_template.replace("REACT_SCRIPT", `\n${react_script}\n`);

		// Read index.html file from the current module location
		const content = fs.readFileSync(root(view_path), "utf8");
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

		return render({
			title,
			react_script,
			ctx: btoa(JSON.stringify(ctxCloned)),
		});
	},
});
