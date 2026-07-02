# Example nodes

Nodes backing the `--examples` scaffold workflows. Registered explicitly via
`index.ts` (a map-export barrel flattened by `discoverNodes`).

| Node | Used by |
|------|---------|
| `chat-ui` | The `/chat`, `/chat-memory`, and `/agent` example pages |

Keep this bundle in lock-step with the shipped example workflows — a node no
workflow references is dead weight registered into every scaffold. Earlier
demo bundles (db-manager, dashboard-generator, workflow-docs, mastra-agent,
image/PDF utilities) were removed in the 2026-07 purge; resurrect from git
history only together with a registered workflow that uses them.
