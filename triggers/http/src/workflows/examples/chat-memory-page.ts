import { http, node, step, workflow } from "@blokjs/core";

export default workflow(
	"Chat (Redis Memory) Page",
	{
		version: "1.0.0",
		description:
			"v0.6.8 — Renders the Redis-memory chat HTML page. Same chat-ui node as /chat, parameterized for the /chat-memory endpoint family. persistSession=true keeps sessionId in localStorage across reloads so the server-side Redis history stays attached. bodyMode=message tells the client to POST only the latest user turn (server reconstructs history from Redis). Pair with chat-memory-message + chat-memory-stream.",
		trigger: http.get("/chat-memory", { accept: "text/html" }),
	},
	() => {
		step("render", node("chat-ui"), {
			endpointBase: "/chat-memory",
			title: "Blok Chat (Redis memory)",
			persistSession: true,
			bodyMode: "message",
		});
	},
);
