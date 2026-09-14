/**
 * The server entrypoint — what `blokctl create` writes for you, spelled out by
 * hand because this example is not a scaffolded project (see the README).
 *
 * A scaffold owns a COPY of the HTTP runner at `src/triggers/http/runner/`,
 * whose `HttpTrigger` statically imports the project's own `src/Nodes.ts` and
 * `src/Workflows.ts`. An in-repo example has no copy, so it imports the
 * trigger from the package (not published; it resolves through the repo's root
 * install) and registers the same two maps by hand. Everything after that is
 * identical: `listen()` auto-discovers `src/workflows/*.ts`, mounts
 * `BLOK_STATIC_DIR`, and publishes `ASSET_VERSION`.
 *
 * ```bash
 * bun run build                                    # the Vite client
 * BLOK_FLASH_SECRET=dev-secret BLOK_STATIC_DIR=client/dist bun run src/index.ts
 * ```
 */

import type { NodeBase } from "@blokjs/shared";
import HttpTrigger from "@blokjs/trigger-http/dist/runner/HttpTrigger.js";
import workflows from "./Workflows.js";
import * as nodes from "./nodes.js";

const trigger = new HttpTrigger();
const registry = trigger.getNodeMap();

// Every `defineNode()` / `runtimeNode()` this example's pages resolve props
// with. The map keys are cosmetic — the runner re-keys by `node.name`.
registry.nodes.addNodes(Object.values(nodes) as unknown as NodeBase[]);

// The middleware chain (`inertia.shared` / `inertia.auth` / `inertia.csrf`).
// The PAGE workflows are not listed here: HTTP-triggered TS workflows under
// `src/workflows/**` are auto-discovered, and registering one twice is a route
// collision (#733).
Object.assign(registry.workflows, workflows);

await trigger.listen();
