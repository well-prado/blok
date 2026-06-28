# ADR 0002 - Canonical node key rule

- **Status:** Accepted (spike resolution - unblocks implementation)
- **Date:** 2026-06-28
- **Resolves:** [#350](https://github.com/well-prado/blok/issues/350)
- **Epic:** [#349](https://github.com/well-prado/blok/issues/349)

## Decision

The canonical module-node ref is `node.name`, and import-registration must register each node under exactly that string; published nodes use their fully-qualified package ref (`@blokjs/api-call`), app-local nodes may use a project-local ref, and duplicate refs throw at startup.

Resolver implication: `step.use` / legacy `node.node` is an exact `NodeMap.get(ref)` lookup. There is no fallback from package name + short name, no generated alternate key, and no last-write-wins shadowing.

## Why this rule

Today the runtime already resolves by one string: `moduleResolver()` calls `opts.nodes.getNode(node.node)`. The bug is that the registration key is hand-authored in `triggers/http/src/Nodes.ts` while `defineNode({ name })` carries a second, sometimes different, identity. Keeping both means catalog output, HMR, JSON workflows, and import-registration can disagree.

Option (a), `node.name === canonical ref`, is the smallest contract that removes the split. Option (b), deriving `packageName + "/" + name`, recreates a resolver rule that does not exist today and still cannot handle app-local nodes. Option (c), a generated manifest barrel, is useful as an implementation detail, but it must emit `node.name` keys, not become a second source of truth.

## Corpus table

Generated from 55 `defineNode()` declarations across `nodes/` and `triggers/http/src/nodes/`. There are 9 current mismatches.

| Registry key today | `node.name` today | Status | Source | File |
|---|---|---|---|---|
| `@blokjs/api-call` | `api-call` | MISMATCH | HTTP `Nodes.ts` | `nodes/web/api-call@1.0.0/index.ts` |
| `@blokjs/audit-log` | `@blokjs/audit-log` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/auditLog.ts` |
| `@blokjs/ctx-publish` | `@blokjs/ctx-publish` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/ctxPublish.ts` |
| `@blokjs/ctx-publish-many` | `@blokjs/ctx-publish-many` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/ctxPublishMany.ts` |
| `@blokjs/expr` | `@blokjs/expr` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/expr.ts` |
| `@blokjs/hmac-verify` | `@blokjs/hmac-verify` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/hmacVerify.ts` |
| `@blokjs/if-else` | `if-else` | MISMATCH | HTTP `Nodes.ts` | `nodes/control-flow/if-else@1.0.0/index.ts` |
| `@blokjs/in-memory-kv` | `@blokjs/in-memory-kv` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/inMemoryKv.ts` |
| `@blokjs/json-schema` | `@blokjs/json-schema` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/jsonSchema.ts` |
| `@blokjs/jwt-verify` | `@blokjs/jwt-verify` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/jwtVerify.ts` |
| `@blokjs/llm-agent` | `@blokjs/llm-agent` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/llmAgent.ts` |
| `@blokjs/llm-stream` | `@blokjs/llm-stream` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/llmStream.ts` |
| `@blokjs/log` | `@blokjs/log` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/log.ts` |
| `@blokjs/metrics-emit` | `@blokjs/metrics-emit` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/metricsEmit.ts` |
| `@blokjs/pubsub-publish` | `@blokjs/pubsub-publish` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/pubsubPublish.ts` |
| `@blokjs/react` | `react` | MISMATCH | node package, not HTTP-registered | `nodes/web/react@1.0.0/index.ts` |
| `@blokjs/redis-kv` | `@blokjs/redis-kv` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/redisKv.ts` |
| `@blokjs/respond` | `@blokjs/respond` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/respond.ts` |
| `@blokjs/sse-emit` | `@blokjs/sse-emit` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/sseEmit.ts` |
| `@blokjs/sse-publish` | `@blokjs/sse-publish` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/ssePublish.ts` |
| `@blokjs/sse-stream` | `@blokjs/sse-stream` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/sseStream.ts` |
| `@blokjs/sse-subscribe` | `@blokjs/sse-subscribe` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/sseSubscribe.ts` |
| `@blokjs/throw` | `@blokjs/throw` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/throw.ts` |
| `@blokjs/worker-publish` | `@blokjs/worker-publish` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/workerPublish.ts` |
| `@blokjs/ws-broadcast` | `@blokjs/ws-broadcast` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/wsBroadcast.ts` |
| `@blokjs/ws-close` | `@blokjs/ws-close` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/wsClose.ts` |
| `@blokjs/ws-reply` | `@blokjs/ws-reply` | OK | `HELPER_NODES` | `nodes/utility/helpers@1.0.0/src/wsReply.ts` |
| `array-map` | `array-map` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/dashboard-generator/ArrayMap.ts` |
| `base64-pdf` | `base64-to-pdf` | MISMATCH | `ExampleNodes` | `triggers/http/src/nodes/examples/base64-pdf/index.ts` |
| `chain-init` | `chain-init` | OK | HTTP `Nodes.ts` | `triggers/http/src/nodes/chain-init/index.ts` |
| `chain-verify` | `chain-verify` | OK | HTTP `Nodes.ts` | `triggers/http/src/nodes/chain-verify/index.ts` |
| `chat-ui` | `chat-ui` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/chat-ui/index.ts` |
| `dashboard-charts-generator` | `dashboard-charts-generator` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/dashboard-generator/DashboardChartsGenerator.ts` |
| `dashboard-ui` | `dashboard-generator-ui` | MISMATCH | `ExampleNodes` | `triggers/http/src/nodes/examples/dashboard-generator/ui/index.ts` |
| `database-ui` | `database-ui` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/db-manager/ui/index.ts` |
| `directory-manager` | `directory-manager` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/workflow-docs/DirectoryManager.ts` |
| `error` | `error-node` | MISMATCH | `ExampleNodes` | `triggers/http/src/nodes/examples/workflow-docs/ErrorNode.ts` |
| `eval-load-items` | `eval-load-items` | OK | `EvalNodes` | `triggers/http/src/nodes/eval/index.ts` |
| `eval-score` | `eval-score` | OK | `EvalNodes` | `triggers/http/src/nodes/eval/index.ts` |
| `eval-search` | `eval-search` | OK | `EvalNodes` | `triggers/http/src/nodes/eval/index.ts` |
| `feedback-ui` | `feedback-ui` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/feedback-ui/index.ts` |
| `file-manager` | `file-manager` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/workflow-docs/FileManager.ts` |
| `image-capture-ui` | `image-capture-ui` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/image-capture/index.ts` |
| `mapper` | `mapper-node` | MISMATCH | `ExampleNodes` | `triggers/http/src/nodes/examples/db-manager/MapperNode.ts` |
| `mastra-agent` | `mastra-agent` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/mastra-agent/index.ts` |
| `memory-storage` | `memory-storage` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/dashboard-generator/MemoryStorage.ts` |
| `mongodb-query` | `mongo-query` | MISMATCH | `ExampleNodes` | `triggers/http/src/nodes/examples/mongodb-query.ts` |
| `multiple-query-generator` | `multiple-query-generator` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/dashboard-generator/MultipleQueryGeneratorNode.ts` |
| `openai` | `openai` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/workflow-docs/OpenAI.ts` |
| `postgres-query` | `postgres-query` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/postgres-query/index.ts` |
| `query-generator` | `query-generator` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/db-manager/QueryGeneratorNode.ts` |
| `runtime-bridge` | `runtime-bridge` | OK | HTTP `Nodes.ts` | `triggers/http/src/nodes/runtime-bridge/index.ts` |
| `save-image` | `save-image-base64` | MISMATCH | `ExampleNodes` | `triggers/http/src/nodes/examples/save-base64-image/index.ts` |
| `weather-ui` | `weather-ui` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/mastra-agent/ui/index.ts` |
| `workflow-ui` | `workflow-ui` | OK | `ExampleNodes` | `triggers/http/src/nodes/examples/workflow-docs/ui/index.ts` |

## Migration delta

These node files must change so `node.name` equals the canonical ref already used by workflows and registries:

| File | Change |
|---|---|
| `nodes/web/api-call@1.0.0/index.ts` | `api-call` -> `@blokjs/api-call` |
| `nodes/control-flow/if-else@1.0.0/index.ts` | `if-else` -> `@blokjs/if-else` |
| `nodes/web/react@1.0.0/index.ts` | `react` -> `@blokjs/react` |
| `triggers/http/src/nodes/examples/base64-pdf/index.ts` | `base64-to-pdf` -> `base64-pdf` |
| `triggers/http/src/nodes/examples/dashboard-generator/ui/index.ts` | `dashboard-generator-ui` -> `dashboard-ui` |
| `triggers/http/src/nodes/examples/workflow-docs/ErrorNode.ts` | `error-node` -> `error` |
| `triggers/http/src/nodes/examples/db-manager/MapperNode.ts` | `mapper-node` -> `mapper` |
| `triggers/http/src/nodes/examples/mongodb-query.ts` | `mongo-query` -> `mongodb-query` |
| `triggers/http/src/nodes/examples/save-base64-image/index.ts` | `save-image-base64` -> `save-image` |

The implementation task should also:

- register imported module nodes under `node.name`;
- expose both `ref` and display `name` in the node catalog, with `ref` as the value authors paste into `use`;
- make duplicate refs a startup error;
- apply the same `node.name` key on HMR reloads.

## Back-compat note

Existing workflows already use the registry keys in the left column. Renaming the 9 `node.name` fields to those refs preserves workflow text and fixes the catalog/import-registration identity split. No alias layer is needed for this corpus.
