import type { SessionJsonValue } from "@blokjs/shared";
import { z } from "zod";
import type {
	AssembledModelResponse,
	AssembledToolCall,
	ModelContentBlock,
	ModelStreamChunk,
	ModelUsage,
	ModelUsageDelta,
} from "./contracts";
import {
	AGENT_KERNEL_MAX_OUTPUT_BYTES,
	AGENT_KERNEL_MAX_STREAM_CHUNKS,
	AGENT_KERNEL_MAX_TOOL_CALLS,
	AgentKernelError,
	parseModelStreamChunk,
} from "./contracts";

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

export interface StreamAssemblyOptions {
	readonly maxOutputBytes?: number;
	readonly maxToolCalls?: number;
	readonly maxChunks?: number;
}

interface MutableToolCall {
	readonly id: string;
	name?: string;
	argumentsText: string;
}

function addUsage(current: ModelUsage, delta: ModelUsageDelta): ModelUsage {
	const inputTokens = current.inputTokens + (delta.inputTokens ?? 0);
	const outputTokens = current.outputTokens + (delta.outputTokens ?? 0);
	const totalTokens = current.totalTokens + (delta.totalTokens ?? (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0));
	const costUsd = (current.costUsd ?? 0) + (delta.costUsd ?? 0);
	return {
		inputTokens,
		outputTokens,
		totalTokens,
		...(costUsd > 0 ? { costUsd } : {}),
	};
}

function malformedTool(message: string, cause?: unknown): AgentKernelError {
	return new AgentKernelError("MALFORMED_TOOL_CALL", message, cause);
}

function parseArguments(value: string, callId: string): SessionJsonValue {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw malformedTool(`tool call ${callId} has invalid JSON arguments`, error);
	}
	const result = jsonValue.safeParse(parsed);
	if (!result.success) throw malformedTool(`tool call ${callId} arguments are not a JSON value`, result.error);
	return result.data;
}

/**
 * Assemble a provider stream without provider-specific assumptions. Chunk
 * indexes must be contiguous, usage chunks are deltas, and a finish chunk is
 * required. These rules make replay and persisted stream facts deterministic.
 */
export class ModelStreamAssembler {
	private readonly content: ModelContentBlock[] = [];
	private readonly toolCalls = new Map<string, MutableToolCall>();
	private text = "";
	private usage: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
	private finishReason: AssembledModelResponse["finishReason"] | undefined;
	private chunksSeen = 0;
	private lastIndex = -1;
	private outputBytes = 0;

	constructor(private readonly options: StreamAssemblyOptions = {}) {}

	get chunkCount(): number {
		return this.chunksSeen;
	}

	add(rawChunk: ModelStreamChunk): void {
		if (this.finishReason !== undefined)
			throw new AgentKernelError("PARTIAL_STREAM", "model emitted data after finish");
		const chunk = parseModelStreamChunk(rawChunk);
		const maxChunks = this.options.maxChunks ?? AGENT_KERNEL_MAX_STREAM_CHUNKS;
		if (this.chunksSeen >= maxChunks)
			throw new AgentKernelError("BUDGET_EXCEEDED", "model stream chunk budget exceeded");
		if (chunk.index !== this.lastIndex + 1)
			throw new AgentKernelError("PARTIAL_STREAM", `model stream index ${chunk.index} is not ${this.lastIndex + 1}`);
		this.lastIndex = chunk.index;
		this.chunksSeen += 1;

		switch (chunk.kind) {
			case "text-delta":
				this.text += chunk.text;
				this.outputBytes += new TextEncoder().encode(chunk.text).byteLength;
				break;
			case "content":
				this.content.push(chunk.content);
				if (chunk.content.type === "text") this.outputBytes += new TextEncoder().encode(chunk.content.text).byteLength;
				break;
			case "tool-call-delta": {
				let call = this.toolCalls.get(chunk.callId);
				if (!call) {
					const maxToolCalls = this.options.maxToolCalls ?? AGENT_KERNEL_MAX_TOOL_CALLS;
					if (this.toolCalls.size >= maxToolCalls)
						throw new AgentKernelError("BUDGET_EXCEEDED", "tool-call budget exceeded");
					call = { id: chunk.callId, argumentsText: "" };
					this.toolCalls.set(chunk.callId, call);
				}
				if (chunk.name !== undefined && call.name !== undefined && chunk.name !== call.name)
					throw malformedTool(`tool call ${chunk.callId} changed name during streaming`);
				if (chunk.name !== undefined) call.name = chunk.name;
				call.argumentsText += chunk.argumentsDelta;
				break;
			}
			case "usage":
				this.usage = addUsage(this.usage, chunk.usage);
				break;
			case "finish":
				this.finishReason = chunk.reason;
				break;
		}
		const maxOutputBytes = this.options.maxOutputBytes ?? AGENT_KERNEL_MAX_OUTPUT_BYTES;
		if (this.outputBytes > maxOutputBytes)
			throw new AgentKernelError("BUDGET_EXCEEDED", "model output byte budget exceeded");
	}

	finish(): AssembledModelResponse {
		if (this.finishReason === undefined)
			throw new AgentKernelError("PARTIAL_STREAM", "model stream ended without a finish chunk");
		const toolCalls: AssembledToolCall[] = [];
		for (const call of this.toolCalls.values()) {
			if (!call.name) throw malformedTool(`tool call ${call.id} has no name`);
			toolCalls.push({ id: call.id, name: call.name, arguments: parseArguments(call.argumentsText, call.id) });
		}
		return {
			text: this.text,
			content: [...this.content],
			toolCalls,
			usage: this.usage,
			finishReason: this.finishReason,
			chunkCount: this.chunksSeen,
			outputBytes: this.outputBytes,
		};
	}
}

export async function assembleModelStream(
	chunks: AsyncIterable<ModelStreamChunk>,
	options?: StreamAssemblyOptions,
): Promise<AssembledModelResponse> {
	const assembler = new ModelStreamAssembler(options);
	try {
		for await (const chunk of chunks) assembler.add(chunk);
	} catch (error) {
		if (error instanceof AgentKernelError) throw error;
		throw new AgentKernelError("PROVIDER_DISCONNECT", "model provider disconnected during streaming", error);
	}
	return assembler.finish();
}

export function chunkEventPayload(chunk: ModelStreamChunk): SessionJsonValue {
	return JSON.parse(JSON.stringify(parseModelStreamChunk(chunk))) as SessionJsonValue;
}
