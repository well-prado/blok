import { js, node, step, workflow } from "@blokjs/core";

export default workflow(
	"WebSocket Echo",
	{
		version: "1.0.0",
		description:
			"Bidirectional realtime over a WebSocket — replies to each inbound message on the same connection. Example of the `websocket` trigger (two-way), NOT http (request/response) or sse (one-way push). One run per inbound message/lifecycle event.",
		trigger: {
			websocket: { path: "/ws/echo", events: ["open", "message", "close"] },
		},
	},
	(conn) => {
		step("reply", node("@blokjs/ws-reply"), {
			message: js`({ echo: ${conn.body}, at: Date.now() })`,
		});
	},
);
