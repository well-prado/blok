/**
 * @blokjs/trigger-websocket
 *
 * WebSocket trigger for Blok workflows — real-time bidirectional
 * communication on the same Hono server that hosts HTTP routes.
 *
 * v0.7+ usage (just add it to your workflow):
 *
 * ```json
 * {
 *   "name": "chat-handler",
 *   "trigger": {
 *     "websocket": {
 *       "path": "/ws/chat/:roomId",
 *       "events": ["message", "typing", "leave"],
 *       "middleware": ["jwt-auth"]
 *     }
 *   },
 *   "steps": [
 *     {
 *       "id": "broadcast",
 *       "use": "@blokjs/ws-broadcast",
 *       "inputs": {
 *         "room": "$.req.params.roomId",
 *         "event": "message",
 *         "payload": { "from": "$.state.identity.userId", "text": "$.req.body.data.text" }
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * Authors construct the trigger with the shared Hono app (typically
 * from `HttpTrigger`) and optionally a reference to that HttpTrigger
 * so WebSocketTrigger can hook `injectWebSocket(server)` into the
 * post-`serve()` callback. See
 * [additional-triggers-plan.mdx](../../../docs/c/devtools/additional-triggers-plan.mdx#websocket-trigger)
 * for the full design.
 */

import WebSocketTrigger, { _getActiveWebSocketTrigger, _setActiveWebSocketTrigger } from "./WebSocketTrigger";

// Re-export under both default AND named names. Consumer code that does
// `import WebSocketTrigger from "@blokjs/trigger-websocket"` (HTTP
// trigger's `src/index.ts`) gets the default; `import { WebSocketTrigger }`
// gets the named alias.
export default WebSocketTrigger;
export { WebSocketTrigger, _getActiveWebSocketTrigger, _setActiveWebSocketTrigger };
export type { ConnectionContext } from "@blokjs/shared";
export type { WebSocketTriggerOpts } from "@blokjs/helper";
