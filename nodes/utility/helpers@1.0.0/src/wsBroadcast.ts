import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.7 — broadcast a message to every WebSocket connection in a
 * room/channel. Use to fan out updates from one connection's message
 * to peers (chat, real-time dashboards, collaborative editing).
 *
 * Rooms are workflow-scoped — `room: "lobby"` from workflow A and
 * workflow B target different sets of connections. Authors join rooms
 * via `ctx.connection.joinRoom(name)` inside a connect/message
 * workflow run.
 *
 * Rooms are in-process only in v0.7. Cross-instance broadcast (NATS-
 * backed backplane) is deferred per the additional-triggers plan;
 * single-instance deployments work out of the box.
 *
 * To exclude the sending connection from the broadcast (the "send to
 * everyone except me" pattern), set `exceptSelf: true`.
 */
export default defineNode({
	name: "@blokjs/ws-broadcast",
	description: "Broadcast a message to every WebSocket connection in a room.",
	input: z.object({
		room: z.string().min(1).describe("Room name (workflow-scoped)."),
		event: z
			.string()
			.optional()
			.describe("Optional event name. Payload wrapped as `{ event, data: payload }` when set."),
		payload: z.unknown(),
		exceptSelf: z
			.boolean()
			.optional()
			.describe("When true, skip the connection that triggered the current workflow run (the sender)."),
		raw: z.boolean().optional().describe("When true, send the payload as-is (no JSON.stringify)."),
	}),
	output: z.object({
		room: z.string(),
		broadcastCount: z.number(),
	}),
	async execute(ctx, input) {
		if (!ctx.connection) {
			throw new Error(
				"@blokjs/ws-broadcast: ctx.connection is undefined. This step only works inside workflows triggered by `trigger.websocket`.",
			);
		}
		let body: string | ArrayBuffer | Uint8Array;
		if (input.raw === true) {
			if (
				typeof input.payload === "string" ||
				input.payload instanceof ArrayBuffer ||
				input.payload instanceof Uint8Array
			) {
				body = input.payload;
			} else {
				throw new Error("@blokjs/ws-broadcast: `raw: true` requires payload to be string | ArrayBuffer | Uint8Array.");
			}
		} else if (input.event) {
			body = JSON.stringify({ event: input.event, data: input.payload });
		} else {
			body = JSON.stringify(input.payload);
		}
		// The trigger wires `broadcast` on ctx.connection — no need to
		// import the trigger package here.
		const count = ctx.connection.broadcast(input.room, body, { exceptSelf: input.exceptSelf === true });
		return { room: input.room, broadcastCount: count };
	},
});
