import type { SessionJsonValue } from "@blokjs/shared";
import { z } from "zod";

export const AGENT_KERNEL_CONTRACT_VERSION = "1" as const;
export const AGENT_KERNEL_MAX_CHUNK_BYTES = 16 * 1024;
export const AGENT_KERNEL_MAX_OUTPUT_BYTES = 256 * 1024;
export const AGENT_KERNEL_MAX_TOOL_CALLS = 64;
export const AGENT_KERNEL_MAX_STREAM_CHUNKS = 4096;
export const AGENT_KERNEL_MAX_TOOLS = 128;

export type ModelRole = "system" | "user" | "assistant" | "tool";
export type FinishReason = "stop" | "tool-call" | "length" | "content-filter";

export interface TextContentBlock {
	readonly type: "text";
	readonly text: string;
}

export interface JsonContentBlock {
	readonly type: "json";
	readonly value: SessionJsonValue;
}

export interface ToolCallContentBlock {
	readonly type: "tool-call";
	readonly id: string;
	readonly name: string;
	readonly arguments: SessionJsonValue;
}

export interface ToolResultContentBlock {
	readonly type: "tool-result";
	readonly toolCallId: string;
	readonly content: SessionJsonValue;
	readonly isError?: boolean;
}

export type ModelContentBlock = TextContentBlock | JsonContentBlock | ToolCallContentBlock | ToolResultContentBlock;

export interface ModelMessage {
	readonly role: ModelRole;
	readonly content: readonly ModelContentBlock[];
	readonly name?: string;
	readonly toolCallId?: string;
}

export interface ModelToolDefinition {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: SessionJsonValue;
	readonly kind?: "capability" | "workflow";
	readonly workflowName?: string;
}

export interface ModelRequest {
	readonly contractVersion: typeof AGENT_KERNEL_CONTRACT_VERSION;
	readonly idempotencyKey: string;
	readonly model: string;
	readonly messages: readonly ModelMessage[];
	readonly tools: readonly ModelToolDefinition[];
	readonly maxOutputTokens?: number;
	readonly signal?: AbortSignal;
}

export interface ModelUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly costUsd?: number;
}

export interface ModelUsageDelta {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
}

export type ModelStreamChunk =
	| { readonly kind: "text-delta"; readonly index: number; readonly text: string }
	| { readonly kind: "content"; readonly index: number; readonly content: ModelContentBlock }
	| {
			readonly kind: "tool-call-delta";
			readonly index: number;
			readonly callId: string;
			readonly name?: string;
			readonly argumentsDelta: string;
	  }
	| { readonly kind: "usage"; readonly index: number; readonly usage: ModelUsageDelta }
	| { readonly kind: "finish"; readonly index: number; readonly reason: FinishReason };

export interface AssembledToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: SessionJsonValue;
}

export interface AssembledModelResponse {
	readonly text: string;
	readonly content: readonly ModelContentBlock[];
	readonly toolCalls: readonly AssembledToolCall[];
	readonly usage: ModelUsage;
	readonly finishReason: FinishReason;
	readonly chunkCount: number;
	readonly outputBytes: number;
}

export type AgentErrorCode =
	| "CONTEXT_OVERFLOW"
	| "CONTEXT_COMPACTION_FAILED"
	| "RATE_LIMIT"
	| "PROVIDER_DISCONNECT"
	| "MALFORMED_TOOL_CALL"
	| "PARTIAL_STREAM"
	| "BUDGET_EXCEEDED"
	| "CANCELLED"
	| "TIMEOUT"
	| "TOOL_FAILED"
	| "RECOVERY_INCOMPLETE_CALL"
	| "SESSION_CLOSED"
	| "INVALID_CONTRACT";

export class AgentKernelError extends Error {
	readonly name = "AgentKernelError";

	constructor(
		public readonly code: AgentErrorCode,
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
	}
}

export interface ModelAdapter {
	readonly name: string;
	stream(request: ModelRequest): AsyncIterable<ModelStreamChunk>;
}

export interface AgentToolRequest {
	readonly id: string;
	readonly name: string;
	readonly arguments: SessionJsonValue;
	readonly definition?: ModelToolDefinition;
	readonly sessionId: string;
	readonly turnId: string;
	readonly step: number;
	readonly idempotencyKey: string;
	readonly signal: AbortSignal;
}

export interface AgentToolResult {
	readonly content: SessionJsonValue;
	readonly isError?: boolean;
	readonly workflowRunId?: string;
}

/**
 * The only effect seam used by the kernel. Implementations must validate the
 * tool input against its definition and authorize the resulting capability or
 * workflow through Blok's policy pipeline before executing it.
 */
export interface AgentDispatcher {
	dispatch(request: AgentToolRequest): Promise<AgentToolResult>;
}

export interface AgentBudgetLimits {
	readonly maxTokens?: number;
	readonly maxCostUsd?: number;
	readonly maxDurationMs?: number;
	readonly maxSteps?: number;
	readonly maxToolCalls?: number;
	readonly maxOutputBytes?: number;
}

export interface AgentKernelOptions {
	readonly sessionStore: import("@blokjs/shared").SessionStore;
	readonly adapter: ModelAdapter;
	readonly dispatcher?: AgentDispatcher;
	readonly model?: string;
	readonly tools?: readonly ModelToolDefinition[];
	readonly budgets?: AgentBudgetLimits;
	/** Retries provider failures only before the provider emits a stream fact. */
	readonly maxRetries?: number;
	readonly principalId?: string;
	readonly now?: () => number;
	/** Optional provider-neutral context sources and compaction seam. */
	readonly context?: import("./context").ContextPipelineOptions;
}

export interface StartTurnInput {
	readonly sessionId: string;
	readonly content: SessionJsonValue;
	readonly turnId?: string;
	readonly signal?: AbortSignal;
}

export interface AcceptedTurn {
	readonly sessionId: string;
	readonly turnId: string;
	readonly accepted: true;
}

export interface ExecuteTurnInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly content?: SessionJsonValue;
	readonly signal?: AbortSignal;
}

export interface CompletedTurn {
	readonly sessionId: string;
	readonly turnId: string;
	readonly status: "completed" | "failed" | "cancelled";
	readonly content?: SessionJsonValue;
	readonly error?: AgentKernelError;
}

export interface RecoveryResult {
	readonly sessionId: string;
	readonly recoveredTurnIds: readonly string[];
	readonly failedTurnIds: readonly string[];
}

const jsonValue: z.ZodType<SessionJsonValue> = z.lazy(() =>
	z.union([
		z.string().max(8 * 1024),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(jsonValue).max(256),
		z.record(jsonValue).refine((value) => Object.keys(value).length <= 256),
	]),
);

const contentBlock = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string().min(1).max(AGENT_KERNEL_MAX_CHUNK_BYTES) }).strict(),
	z.object({ type: z.literal("json"), value: jsonValue }).strict(),
	z
		.object({
			type: z.literal("tool-call"),
			id: z.string().min(1).max(256),
			name: z.string().min(1).max(256),
			arguments: jsonValue,
		})
		.strict(),
	z
		.object({
			type: z.literal("tool-result"),
			toolCallId: z.string().min(1).max(256),
			content: jsonValue,
			isError: z.boolean().optional(),
		})
		.strict(),
]);

const modelMessage = z
	.object({
		role: z.enum(["system", "user", "assistant", "tool"]),
		content: z.array(contentBlock).max(256),
		name: z.string().min(1).max(256).optional(),
		toolCallId: z.string().min(1).max(256).optional(),
	})
	.strict();

const modelToolDefinition = z
	.object({
		name: z.string().min(1).max(256),
		description: z
			.string()
			.max(8 * 1024)
			.optional(),
		inputSchema: jsonValue,
		kind: z.enum(["capability", "workflow"]).optional(),
		workflowName: z.string().min(1).max(256).optional(),
	})
	.strict();

export const ModelRequestSchema = z
	.object({
		contractVersion: z.literal(AGENT_KERNEL_CONTRACT_VERSION),
		idempotencyKey: z.string().min(1).max(256),
		model: z.string().min(1).max(256),
		messages: z.array(modelMessage).max(4096),
		tools: z.array(modelToolDefinition).max(AGENT_KERNEL_MAX_TOOLS),
		maxOutputTokens: z.number().int().positive().safe().optional(),
		signal: z.custom<AbortSignal>().optional(),
	})
	.strict();

const usageDelta = z
	.object({
		inputTokens: z.number().int().nonnegative().safe().optional(),
		outputTokens: z.number().int().nonnegative().safe().optional(),
		totalTokens: z.number().int().nonnegative().safe().optional(),
		costUsd: z.number().finite().nonnegative().optional(),
	})
	.strict();

export const ModelStreamChunkSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("text-delta"),
			index: z.number().int().nonnegative().safe(),
			text: z.string().max(AGENT_KERNEL_MAX_CHUNK_BYTES),
		})
		.strict(),
	z
		.object({ kind: z.literal("content"), index: z.number().int().nonnegative().safe(), content: contentBlock })
		.strict(),
	z
		.object({
			kind: z.literal("tool-call-delta"),
			index: z.number().int().nonnegative().safe(),
			callId: z.string().min(1).max(256),
			name: z.string().min(1).max(256).optional(),
			argumentsDelta: z.string().max(AGENT_KERNEL_MAX_CHUNK_BYTES),
		})
		.strict(),
	z.object({ kind: z.literal("usage"), index: z.number().int().nonnegative().safe(), usage: usageDelta }).strict(),
	z
		.object({
			kind: z.literal("finish"),
			index: z.number().int().nonnegative().safe(),
			reason: z.enum(["stop", "tool-call", "length", "content-filter"]),
		})
		.strict(),
]);

export function parseModelStreamChunk(value: unknown): ModelStreamChunk {
	const parsed = ModelStreamChunkSchema.safeParse(value);
	if (!parsed.success)
		throw new AgentKernelError("INVALID_CONTRACT", "model adapter emitted an invalid stream chunk", parsed.error);
	return parsed.data;
}

export function parseModelRequest(value: unknown): ModelRequest {
	const parsed = ModelRequestSchema.safeParse(value);
	if (!parsed.success) throw new AgentKernelError("INVALID_CONTRACT", "model request is invalid", parsed.error);
	return parsed.data;
}

export function assertBudgetLimit(value: number | undefined, name: string): void {
	if (value !== undefined && (!Number.isFinite(value) || value < 0))
		throw new AgentKernelError("INVALID_CONTRACT", `${name} must be non-negative`);
}
