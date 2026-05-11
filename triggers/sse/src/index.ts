/**
 * @blokjs/trigger-sse
 *
 * Server-Sent Events trigger for Blok workflows. Mounts on the shared
 * Hono server alongside HTTP and WebSocket routes — same port, same
 * middleware chain, same Studio tracing.
 *
 * v0.7+ usage (just add the trigger to your workflow):
 *
 * ```json
 * {
 *   "name": "live-clock",
 *   "trigger": {
 *     "sse": {
 *       "path": "/sse/clock",
 *       "heartbeatInterval": 15000,
 *       "retryInterval": 3000
 *     }
 *   },
 *   "steps": [
 *     { "id": "sub",    "use": "@blokjs/sse-subscribe", "inputs": { "channels": ["clock-ticks"] } },
 *     { "id": "stream", "use": "@blokjs/sse-stream",    "inputs": { "source": "$.state.sub", "eventName": "tick" } }
 *   ]
 * }
 * ```
 *
 * See [additional-triggers-plan.mdx](../../../docs/c/devtools/additional-triggers-plan.mdx#sse-trigger)
 * for the full design.
 */

import SSETrigger, { _getActiveSSETrigger, _setActiveSSETrigger } from "./SSETrigger";

export default SSETrigger;
export { SSETrigger, _getActiveSSETrigger, _setActiveSSETrigger };
export { getBus as _getSSEBus, _resetBusForTests } from "./bus";
export type { BusEvent } from "./bus";
export type { StreamContext } from "@blokjs/shared";
export type { SSETriggerOpts } from "@blokjs/helper";
