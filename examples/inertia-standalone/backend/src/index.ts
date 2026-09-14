/**
 * The backend entrypoint — what `blokctl create` writes for you, spelled out by
 * hand because this example is not a scaffolded project (see the README).
 *
 * Standalone mode: this server answers the Inertia protocol and nothing else.
 * The SPA is served by Vite on its own origin, so there is no `BLOK_STATIC_DIR`
 * and no HTML shell in the happy path — `BLOK_CORS_ORIGIN` is what makes the
 * two origins talk.
 *
 * ```bash
 * BLOK_FLASH_SECRET=dev-secret BLOK_CORS_ORIGIN=http://localhost:5173 \
 *   bun run src/index.ts          # from examples/inertia-standalone/backend
 * ```
 */

import type { NodeBase } from "@blokjs/shared";
import HttpTrigger from "@blokjs/trigger-http/dist/runner/HttpTrigger.js";
import workflows from "./Workflows.js";
import * as nodes from "./nodes.js";

const trigger = new HttpTrigger();
const registry = trigger.getNodeMap();

registry.nodes.addNodes(Object.values(nodes) as unknown as NodeBase[]);
Object.assign(registry.workflows, workflows);

await trigger.listen();
