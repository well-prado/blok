/**
 * @blokjs/trigger-sse
 *
 * Server-Sent Events (SSE) trigger for Blok workflows.
 * Handle real-time server-to-client push notifications.
 *
 * Features:
 * - Channel/topic subscriptions
 * - Automatic reconnection support (via retry)
 * - Event type filtering
 * - Connection health monitoring
 * - Message history replay (via Last-Event-ID)
 *
 * @example
 * ```typescript
 * import { SSETrigger } from "@blokjs/trigger-sse";
 * import express from "express";
 *
 * class MySSETrigger extends SSETrigger {
 *   protected nodes = myNodes;
 *   protected workflows = myWorkflows;
 * }
 *
 * const trigger = new MySSETrigger();
 * await trigger.listen();
 *
 * const app = express();
 *
 * // SSE endpoint
 * app.get("/events/:channel", async (req, res) => {
 *   // Set SSE headers
 *   res.setHeader("Content-Type", "text/event-stream");
 *   res.setHeader("Cache-Control", "no-cache");
 *   res.setHeader("Connection", "keep-alive");
 *
 *   const client = await trigger.handleConnection(
 *     (data) => { res.write(data); return true; },
 *     () => res.end(),
 *     req.headers as Record<string, string>,
 *     { userId: req.user?.id }
 *   );
 *
 *   if (!client) return;
 *
 *   // Subscribe to channel
 *   await trigger.subscribe(client.id, req.params.channel);
 *
 *   // Handle disconnect
 *   req.on("close", () => {
 *     trigger.handleDisconnect(client.id);
 *   });
 * });
 *
 * // Send events
 * app.post("/events/:channel", async (req, res) => {
 *   const sent = trigger.broadcastToChannel(req.params.channel, {
 *     id: uuid(),
 *     event: req.body.event,
 *     data: req.body.data,
 *   });
 *   res.json({ sent });
 * });
 * ```
 *
 * Workflow Definition:
 * ```typescript
 * Workflow({ name: "sse-handler", version: "1.0.0" })
 *   .addTrigger("sse", {
 *     events: ["connect", "disconnect", "subscribe"],
 *     channels: ["notifications", "updates"],
 *   })
 *   .addStep({ ... });
 * ```
 *
 * Client-side Usage:
 * ```javascript
 * const eventSource = new EventSource("/events/notifications");
 *
 * eventSource.onmessage = (event) => {
 *   console.log("Message:", event.data);
 * };
 *
 * eventSource.addEventListener("notification", (event) => {
 *   console.log("Notification:", JSON.parse(event.data));
 * });
 *
 * eventSource.onerror = (error) => {
 *   console.error("SSE error:", error);
 * };
 * ```
 *
 * Event Format:
 * ```
 * id: event-123
 * event: notification
 * data: {"message": "Hello, World!"}
 *
 * ```
 */

// Core exports
export {
	SSETrigger,
	type SSEEvent,
	type SSEState,
	type SSEClient,
	type SSEChannel,
	type SSEEventType,
	type SSEConnectionEvent,
} from "./SSETrigger";

// Re-export types from helper for convenience
export type { SSETriggerOpts } from "@blokjs/helper";
