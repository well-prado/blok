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

import AuditLogNode, { _resetAuditEventsForTests, getAuditEvents } from "./auditLog";
import CtxPublishNode from "./ctxPublish";
import CtxPublishManyNode from "./ctxPublishMany";
import ExprNode from "./expr";
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
	"@blokjs/hmac-verify": HmacVerifyNode,
	"@blokjs/in-memory-kv": InMemoryKvNode,
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
