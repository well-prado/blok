import fs from "node:fs";
import path from "node:path";
import { defineNode } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import ejs from "ejs";
import { z } from "zod";

/**
 * chat-ui — renders a self-contained HTML chat client backed by the
 * Blok SSE bus + a streaming LLM workflow.
 *
 * Pattern mirrors `feedback-ui` / `dashboard-ui`: read an `index.html`
 * template, render via EJS, return as `text/html`. The page contains:
 *
 *   - A message list rendered client-side from local state
 *   - A textarea + send button
 *   - JS that:
 *       1. Generates a `sessionId` on load (random UUID).
 *       2. Opens `EventSource("/sse/chat/" + sessionId)`.
 *       3. On send: POSTs to `/chat/" + sessionId + "/message`.
 *       4. Listens for `token` SSE events → appends delta to the
 *          active assistant message bubble.
 *       5. Listens for `done` SSE event → finalizes the bubble.
 *
 * No build step, no React, no Tailwind — inline `<style>` + a small
 * `<script>` block. Ships as the chat scaffold's entry page.
 */
const rootDir = path.resolve(__dirname, ".");
const root = (relPath: string) => path.resolve(rootDir, relPath);

export default defineNode({
	name: "chat-ui",
	description: "Renders the Blok chat demo page (vanilla HTML + EventSource + fetch).",
	contentType: "text/html",
	input: z.object({}),
	output: z.string(),
	async execute(_ctx: Context, _input) {
		const content = fs.readFileSync(root("index.html"), "utf8");
		return ejs.render(content, {});
	},
});
