/**
 * React Node - Function-First Implementation
 *
 * Renders React applications by loading a compiled React bundle and rendering it in an HTML template.
 * Migrated from class-based to function-first pattern using defineNode.
 */

import fs from "node:fs";
import path from "node:path";
import { defineNode } from "@nanoservice-ts/runner";
import type { Context } from "@nanoservice-ts/shared";
import ejs from "ejs";
import { z } from "zod";

// Input schema using Zod (migrated from JSON Schema)
const inputSchema = z.object({
	react_app: z.string({
		description: "Path to the compiled React application bundle (e.g., './app/index.merged.min.js')",
	}),
	title: z.string().optional().default("React App"),
	scripts: z.string().optional().default(""),
	metas: z.string().optional().default(""),
	index_html: z.string().optional().default("index.html"),
	styles: z.string().optional().default(""),
	root_element: z.string().optional().default("root"),
});

// Output is HTML string
const outputSchema = z.string();

// Helper: Resolve path relative to node directory
const rootDir = path.resolve(__dirname, ".");
function root(relPath: string): string {
	return path.resolve(rootDir, relPath);
}

export default defineNode({
	name: "react",
	description: "Renders React applications by loading a compiled bundle and rendering it in an HTML template",

	input: inputSchema,
	output: outputSchema,

	async execute(ctx: Context, inputs) {
		// Resolve React app bundle path
		const file_path = inputs.react_app || "./app/index.merged.min.js";
		const react_script_template = '<script type="text/babel">REACT_SCRIPT</script>';

		// Load React script from the node module location
		const min_file = root(file_path);
		let react_app = fs.readFileSync(min_file, "utf8");
		react_app = react_script_template.replace("REACT_SCRIPT", `\n${react_app}\n`);

		// Read index.html template from the node module location
		const content = fs.readFileSync(root(inputs.index_html), "utf8");
		const render = ejs.compile(content, { client: false });

		// Clone context for template (removing sensitive data)
		const ctxCloned = {
			config: ctx.config,
			inputs: inputs,
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

		// Render HTML with EJS
		const html = render({
			title: inputs.title,
			metas: inputs.metas,
			styles: inputs.styles,
			scripts: inputs.scripts,
			root_element: inputs.root_element,
			react_app,
			ctx: btoa(JSON.stringify(ctxCloned)),
		});

		// Note: To set content type to "text/html", the runner needs to support
		// a contentType property in the response or node config
		return html;
	},
});

// Export types for backward compatibility
export type InputType = z.infer<typeof inputSchema>;
export type OutputType = z.infer<typeof outputSchema>;
