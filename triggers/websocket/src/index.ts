/**
 * @nanoservice-ts/trigger-websocket
 *
 * WebSocket trigger for Blok workflows.
 * Handle real-time bidirectional communication.
 *
 * Features:
 * - Connection management (connect, disconnect, reconnect)
 * - Room/channel support for broadcasting
 * - Message routing to workflows
 * - Heartbeat/ping-pong for connection health
 * - Authentication middleware
 * - Binary message support
 *
 * @example
 * ```typescript
 * import { WebSocketTrigger } from "@nanoservice-ts/trigger-websocket";
 * import { WebSocketServer } from "ws";
 *
 * class MyWebSocketTrigger extends WebSocketTrigger {
 *   protected nodes = myNodes;
 *   protected workflows = myWorkflows;
 * }
 *
 * const trigger = new MyWebSocketTrigger();
 * await trigger.listen();
 *
 * // Create WebSocket server
 * const wss = new WebSocketServer({ port: 8080 });
 *
 * wss.on("connection", async (ws, req) => {
 *   const headers = req.headers as Record<string, string>;
 *   const client = await trigger.handleConnection(
 *     {
 *       send: (data) => ws.send(data),
 *       close: (code, reason) => ws.close(code, reason),
 *       ping: () => ws.ping(),
 *     },
 *     req,
 *     headers
 *   );
 *
 *   if (!client) return;
 *
 *   ws.on("message", async (data, isBinary) => {
 *     await trigger.handleMessage(client.id, data, isBinary);
 *   });
 *
 *   ws.on("close", (code, reason) => {
 *     trigger.handleClose(client.id, code, reason.toString());
 *   });
 *
 *   ws.on("error", (error) => {
 *     trigger.handleError(client.id, error);
 *   });
 *
 *   ws.on("ping", () => trigger.handlePing(client.id));
 *   ws.on("pong", () => trigger.handlePong(client.id));
 * });
 * ```
 *
 * Workflow Definition:
 * ```typescript
 * Workflow({ name: "chat-message", version: "1.0.0" })
 *   .addTrigger("websocket", {
 *     events: ["message", "chat.*"],
 *     rooms: ["general", "support"],
 *   })
 *   .addStep({ ... });
 * ```
 *
 * Authentication:
 * ```typescript
 * trigger.setAuthHandler(async (request, headers) => {
 *   const token = headers["authorization"]?.replace("Bearer ", "");
 *   if (!token) {
 *     return { authenticated: false, error: "No token provided" };
 *   }
 *
 *   const user = await verifyToken(token);
 *   if (!user) {
 *     return { authenticated: false, error: "Invalid token" };
 *   }
 *
 *   return {
 *     authenticated: true,
 *     clientId: user.id,
 *     metadata: { userId: user.id, role: user.role },
 *   };
 * });
 * ```
 *
 * Room Management:
 * ```typescript
 * // Join a room
 * await trigger.joinRoom(clientId, "room-name");
 *
 * // Leave a room
 * await trigger.leaveRoom(clientId, "room-name");
 *
 * // Broadcast to room
 * trigger.broadcastToRoom("room-name", "event", { message: "Hello!" });
 *
 * // Send to specific client
 * trigger.sendToClient(clientId, "event", { message: "Private message" });
 *
 * // Broadcast to all
 * trigger.broadcastToAll("event", { message: "System message" });
 * ```
 */

// Core exports
export {
	WebSocketTrigger,
	type WebSocketMessage,
	type WebSocketMessageType,
	type WebSocketState,
	type WebSocketClient,
	type WebSocketRoom,
	type WebSocketEventType,
	type WebSocketEvent,
	type AuthResult,
	type AuthHandler,
} from "./WebSocketTrigger";

// Re-export types from helper for convenience
export type { WebSocketTriggerOpts } from "@nanoservice-ts/helper";
