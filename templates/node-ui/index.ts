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
	name: "react",
	description: "Renders React applications by loading a compiled bundle and rendering it in an HTML template",
	contentType: "text/html",

	input: z.object({
		react_app: z.string(),
		title: z.string().optional().default("React App"),
		scripts: z.string().optional().default(""),
		metas: z.string().optional().default(""),
		index_html: z.string().optional().default("index.html"),
		styles: z.string().optional().default(""),
		root_element: z.string().optional().default("root"),
	}),

	output: z.string(),

	async execute(ctx: Context, input) {
		const file_path = input.react_app || "./app/index.merged.min.js";
		const react_script_template = '<script type="text/babel">REACT_SCRIPT</script>';

		// Load React script from the current module location
		const min_file = root(file_path);
		let react_app = fs.readFileSync(min_file, "utf8");
		react_app = react_script_template.replace("REACT_SCRIPT", `\n${react_app}\n`);

		// Read index.html file from the current module location
		const content = fs.readFileSync(root(input.index_html), "utf8");
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

		const html = render({
			title: input.title,
			metas: input.metas,
			styles: input.styles,
			scripts: input.scripts,
			root_element: input.root_element,
			react_app,
			ctx: btoa(JSON.stringify(ctxCloned)),
		});

		return html;
	},
});
