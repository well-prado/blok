import fs from "node:fs";
import path from "node:path";
import { defineNode } from "@nanoservice-ts/runner";
import ejs from "ejs";
import { z } from "zod";

const rootDir = path.resolve(__dirname, ".");

function root(relPath: string): string {
	return path.resolve(rootDir, relPath);
}

export default defineNode({
	name: "workflow-ui",
	description: "Renders the workflow docs UI from an EJS template",
	contentType: "text/html",

	input: z.object({}),

	output: z.string(),

	async execute(_ctx, _input) {
		const content = fs.readFileSync(root("index.html"), "utf8");
		const render = ejs.compile(content, { client: false });
		return render({});
	},
});
