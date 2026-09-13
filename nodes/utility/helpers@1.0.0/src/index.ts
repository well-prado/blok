/**
 * @blokjs/helpers — generic helper nodes for v0.5 workflow primitives.
 *
 * Each export is a defineNode-built node with a Zod-validated input
 * surface. Designed to be small, predictable, AI-readable, and zero
 * dependencies beyond @blokjs/runner + zod (+ ajv for json-schema).
 *
 * @example
 * ```ts
 * import { ExprNode, InMemoryKvNode } from "@blokjs/helpers";
 * import { GlobalOptions } from "@blokjs/runner";
 *
 * const opts: GlobalOptions = {
 *   nodes: {
 *     "@blokjs/expr": ExprNode,
 *     "@blokjs/in-memory-kv": InMemoryKvNode,
 *     // ...
 *   },
 * };
 * ```
 */

import type { NodeBase } from "@blokjs/shared";
import AuditLogNode, { _resetAuditEventsForTests, getAuditEvents } from "./auditLog";
import CtxPublishNode from "./ctxPublish";
import CtxPublishManyNode from "./ctxPublishMany";
import ExprNode from "./expr";
import FlashNode from "./flash";
import HmacVerifyNode from "./hmacVerify";
import InMemoryKvNode, { _resetInMemoryKvForTests } from "./inMemoryKv";
import JsonSchemaNode from "./jsonSchema";
import JwtVerifyNode, { _resetJwksCacheForTests } from "./jwtVerify";
import LlmAgentNode from "./llmAgent";
import LlmStreamNode from "./llmStream";
import LogNode from "./log";
import MetricsEmitNode from "./metricsEmit";
import PubsubPublishNode from "./pubsubPublish";
import RedisKvNode, { _teardownRedisForTests } from "./redisKv";
import RespondNode from "./respond";
import SseEmitNode from "./sseEmit";
import SsePublishNode from "./ssePublish";
import SseStreamNode from "./sseStream";
import SseSubscribeNode from "./sseSubscribe";
import ThrowNode from "./throw";
import WorkerPublishNode from "./workerPublish";
import WsBroadcastNode from "./wsBroadcast";
import WsCloseNode from "./wsClose";
import WsReplyNode from "./wsReply";

export {
	AuditLogNode,
	CtxPublishNode,
	CtxPublishManyNode,
	ExprNode,
	FlashNode,
	HmacVerifyNode,
	InMemoryKvNode,
	JsonSchemaNode,
	JwtVerifyNode,
	LlmAgentNode,
	LlmStreamNode,
	LogNode,
	MetricsEmitNode,
	PubsubPublishNode,
	RedisKvNode,
	RespondNode,
	SseEmitNode,
	SsePublishNode,
	SseStreamNode,
	SseSubscribeNode,
	ThrowNode,
	WorkerPublishNode,
	WsBroadcastNode,
	WsCloseNode,
	WsReplyNode,
};

// Test-only utilities — exported but tagged with leading underscore
export {
	_resetAuditEventsForTests,
	_resetInMemoryKvForTests,
	_resetJwksCacheForTests,
	_teardownRedisForTests,
	getAuditEvents,
};

/**
 * `@blokjs/inertia` — the Inertia v3 protocol adapter (#994) — ships as its own
 * package: it carries the whole wire protocol, and a project that serves no SPA
 * should not pay for it. It is OPTIONAL and undeclared, loaded through a
 * non-literal specifier + try/catch — exactly the shape
 * `triggers/http/src/Nodes.ts` uses for `@blokjs/browser`, which likewise
 * appears in no manifest. A project that installed it gets the adapter ref
 * `@blokjs/inertia` plus the security nodes `@blokjs/inertia.authorize`,
 * `@blokjs/inertia.logout` and `@blokjs/inertia.history` (#1013); one that did
 * not boots fine without any of them.
 *
 * Deliberately NOT a dependency or a peer: bun installs the dependencies of a
 * `file:`-linked package, so a hard dependency on a package that is not yet on
 * npm breaks `blokctl create`, and a peer entry would only restate what this
 * import already expresses.
 */
const inertiaPkg = "@blokjs/inertia";
/** Every node the Inertia package ships, keyed by its own `name` (ADR 0002). */
const inertiaNodes: Record<string, NodeBase> = {};
try {
	const mod = (await import(inertiaPkg)) as {
		default?: unknown;
		authorizeNode?: unknown;
		logoutNode?: unknown;
		historyNode?: unknown;
	};
	// The adapter plus the three named nodes (#1013). Keys come from each node's
	// own `name` so a JSON workflow's `use:` and this map cannot drift apart.
	for (const candidate of [mod.default, mod.authorizeNode, mod.logoutNode, mod.historyNode]) {
		const node = candidate as NodeBase | undefined;
		if (node?.name) inertiaNodes[node.name] = node;
	}
} catch {
	// not installed — the Inertia nodes are simply unavailable
}

/**
 * Pre-built node map suitable for `GlobalOptions.nodes` registration.
 * Drop this into your scaffold's Nodes.ts to make every helper available
 * by its `@blokjs/<name>` ref:
 *
 * ```ts
 * import { HELPER_NODES } from "@blokjs/helpers";
 * const nodes = { ...HELPER_NODES, ...yourOwnNodes };
 * ```
 */
export const HELPER_NODES = {
	"@blokjs/audit-log": AuditLogNode,
	"@blokjs/ctx-publish": CtxPublishNode,
	"@blokjs/ctx-publish-many": CtxPublishManyNode,
	"@blokjs/expr": ExprNode,
	"@blokjs/flash": FlashNode,
	"@blokjs/hmac-verify": HmacVerifyNode,
	"@blokjs/in-memory-kv": InMemoryKvNode,
	...inertiaNodes,
	"@blokjs/json-schema": JsonSchemaNode,
	"@blokjs/jwt-verify": JwtVerifyNode,
	"@blokjs/llm-agent": LlmAgentNode,
	"@blokjs/llm-stream": LlmStreamNode,
	"@blokjs/log": LogNode,
	"@blokjs/metrics-emit": MetricsEmitNode,
	"@blokjs/pubsub-publish": PubsubPublishNode,
	"@blokjs/redis-kv": RedisKvNode,
	"@blokjs/respond": RespondNode,
	"@blokjs/sse-emit": SseEmitNode,
	"@blokjs/sse-publish": SsePublishNode,
	"@blokjs/sse-stream": SseStreamNode,
	"@blokjs/sse-subscribe": SseSubscribeNode,
	"@blokjs/throw": ThrowNode,
	"@blokjs/worker-publish": WorkerPublishNode,
	"@blokjs/ws-broadcast": WsBroadcastNode,
	"@blokjs/ws-close": WsCloseNode,
	"@blokjs/ws-reply": WsReplyNode,
} as const;

export type { AuditEvent } from "./auditLog";
