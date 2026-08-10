import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineNode } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import ejs from "ejs";
import { z } from "zod";

/**
 * chat-ui — renders a self-contained HTML chat client backed by the
 * Blok SSE bus + a streaming LLM workflow.
 *
 * Parameterized so the same node powers BOTH the v0.6.7 stateless chat
 * (`/chat`) AND the v0.6.8 Redis-memory chat (`/chat-memory`):
 *
 *   - `endpointBase` switches the HTTP POST + SSE URLs (default "/chat" →
 *     POSTs to /chat/:sid/message, opens EventSource at /sse/chat/:sid).
 *   - `title` rewrites the page <title> + <h1>.
 *   - `persistSession=true` stores the generated sessionId in
 *     localStorage so reloading the tab continues the conversation —
 *     required for any memory variant to feel like a real chat. Default
 *     false (preserves the v0.6.7 ephemeral-per-tab behavior).
 *   - `bodyMode="messages"` (default) ships the full client-side history
 *     array on every POST (server is stateless). `bodyMode="message"`
 *     ships only the latest user message — server reconstructs history
 *     from its own store.
 */
// `__dirname` does not exist in ESM. Bun defines it anyway, so this only ever
// blew up where nobody looked: a built `--examples` scaffold run under plain
// Node died with `ReferenceError: __dirname is not defined in ES module scope`
// before the trigger could listen (#741).
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const root = (relPath: string) => path.resolve(rootDir, relPath);

export default defineNode({
	name: "chat-ui",
	description: "Renders the Blok chat demo page (vanilla HTML + EventSource + fetch).",
	contentType: "text/html",
	input: z.object({
		endpointBase: z
			.string()
			.default("/chat")
			.describe(
				'URL prefix for POST + SSE endpoints. Default "/chat" → POSTs to /chat/:sid/message + EventSource on /sse/chat/:sid.',
			),
		title: z.string().default("Blok Chat").describe("Page <title> + <h1>."),
		persistSession: z
			.boolean()
			.default(false)
			.describe(
				"Persist sessionId in localStorage so reload continues the same conversation. Required for memory variants.",
			),
		bodyMode: z
			.enum(["messages", "message"])
			.default("messages")
			.describe(
				"POST body shape — `messages` sends full client history; `message` sends only the latest user turn (server reconstructs).",
			),
	}),
	output: z.string(),
	async execute(_ctx: Context, input) {
		const content = fs.readFileSync(root("index.html"), "utf8");
		return ejs.render(content, {
			endpointBase: input.endpointBase,
			title: input.title,
			persistSession: input.persistSession,
			bodyMode: input.bodyMode,
		});
	},
});
