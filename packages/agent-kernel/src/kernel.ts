import { randomUUID } from "node:crypto";
import type {
	AgentSessionEvent,
	AgentSessionEventKind,
	AgentSessionEventVisibility,
	SessionEventInput,
	SessionJsonValue,
	SessionMessage,
	SessionState,
	SessionStore,
} from "@blokjs/shared";
import { AgentSessionContractError, SessionConcurrencyError, SessionJsonValueSchema } from "@blokjs/shared";
import type {
	AcceptedTurn,
	AgentBudgetLimits,
	AgentDispatcher,
	AgentKernelOptions,
	AgentToolRequest,
	AssembledModelResponse,
	CompletedTurn,
	ExecuteTurnInput,
	ModelContentBlock,
	ModelMessage,
	ModelRequest,
	ModelStreamChunk,
	ModelToolDefinition,
	RecoveryResult,
	StartTurnInput,
} from "./contracts";
import { AgentKernelError, parseModelStreamChunk } from "./contracts";
import { ModelStreamAssembler, chunkEventPayload } from "./stream";

interface ActiveTurn {
	readonly controller: AbortController;
	readonly startedAt: number;
}

interface TurnUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
	steps: number;
	toolCalls: number;
	outputBytes: number;
}

const agentActor = { kind: "agent" as const, id: "agent-kernel" };

function jsonValue(value: unknown): SessionJsonValue {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new AgentKernelError("INVALID_CONTRACT", "kernel value is not JSON serializable", error);
	}
	if (serialized === undefined) throw new AgentKernelError("INVALID_CONTRACT", "kernel value is undefined");
	return JSON.parse(serialized) as SessionJsonValue;
}

function objectValue(value: SessionJsonValue): Readonly<Record<string, SessionJsonValue>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, SessionJsonValue>>)
		: undefined;
}

function errorFor(error: unknown): AgentKernelError {
	if (error instanceof AgentKernelError) return error;
	if (error instanceof AgentSessionContractError) return new AgentKernelError("INVALID_CONTRACT", error.message, error);
	if (error instanceof Error && /context|window/i.test(error.message))
		return new AgentKernelError("CONTEXT_OVERFLOW", error.message, error);
	if (error instanceof Error && /rate.?limit|429/i.test(error.message))
		return new AgentKernelError("RATE_LIMIT", error.message, error);
	return new AgentKernelError("PROVIDER_DISCONNECT", "model provider failed during execution", error);
}

function roleForMessage(message: SessionMessage): ModelMessage {
	const payload = objectValue(message.content);
	if (message.role === "assistant" && payload) {
		const blocks = payload.blocks;
		if (Array.isArray(blocks)) return { role: "assistant", content: blocks as readonly ModelContentBlock[] };
	}
	if (message.role === "tool" && payload) {
		const toolCallId = payload.toolCallId;
		const content = payload.content;
		if (typeof toolCallId === "string" && content !== undefined)
			return {
				role: "tool",
				toolCallId,
				content: [{ type: "tool-result", toolCallId, content, ...(payload.isError === true ? { isError: true } : {}) }],
			};
	}
	return { role: message.role, content: [{ type: "json", value: message.content }] };
}

function usageFromResponse(response: AssembledModelResponse): TurnUsage {
	return {
		inputTokens: response.usage.inputTokens,
		outputTokens: response.usage.outputTokens,
		totalTokens: response.usage.totalTokens,
		costUsd: response.usage.costUsd ?? 0,
		steps: 0,
		toolCalls: 0,
		outputBytes: response.outputBytes,
	};
}

function addUsage(target: TurnUsage, next: TurnUsage): void {
	target.inputTokens += next.inputTokens;
	target.outputTokens += next.outputTokens;
	target.totalTokens += next.totalTokens;
	target.costUsd += next.costUsd;
	target.outputBytes += next.outputBytes;
}

function budgetRemaining(
	limits: AgentBudgetLimits,
	usage: TurnUsage,
	name: keyof AgentBudgetLimits,
): number | undefined {
	const limit = limits[name];
	if (limit === undefined) return undefined;
	const used =
		name === "maxTokens"
			? usage.totalTokens
			: name === "maxCostUsd"
				? usage.costUsd
				: name === "maxSteps"
					? usage.steps
					: name === "maxToolCalls"
						? usage.toolCalls
						: usage.outputBytes;
	return limit - used;
}

function checkBudget(limits: AgentBudgetLimits, usage: TurnUsage, startedAt: number, now: () => number): void {
	const checks: Array<[keyof AgentBudgetLimits, string]> = [
		["maxTokens", "tokens"],
		["maxCostUsd", "costUsd"],
		["maxSteps", "steps"],
		["maxToolCalls", "toolCalls"],
		["maxOutputBytes", "outputBytes"],
	];
	for (const [key, name] of checks) {
		const remaining = budgetRemaining(limits, usage, key);
		if (remaining !== undefined && remaining < 0)
			throw new AgentKernelError("BUDGET_EXCEEDED", `${name} budget exceeded`);
	}
	if (limits.maxDurationMs !== undefined && now() - startedAt > limits.maxDurationMs)
		throw new AgentKernelError("TIMEOUT", "turn time budget exceeded");
}

function findTurnCompleted(events: readonly AgentSessionEvent[], turnId: string): AgentSessionEvent | undefined {
	return events.find((event) => event.turnId === turnId && event.kind === "turn.completed");
}

function payloadChunk(event: AgentSessionEvent): ModelStreamChunk | undefined {
	const payload = objectValue(event.payload);
	const chunk = payload?.chunk;
	if (!chunk) return undefined;
	try {
		return parseModelStreamChunk(chunk);
	} catch {
		throw new AgentKernelError("PARTIAL_STREAM", "persisted model stream chunk is malformed");
	}
}

export class AgentKernel {
	private readonly sessionStore: SessionStore;
	private readonly adapter: AgentKernelOptions["adapter"];
	private readonly dispatcher?: AgentDispatcher;
	private readonly model: string;
	private readonly tools: readonly ModelToolDefinition[];
	private readonly budgets: AgentBudgetLimits;
	private readonly maxRetries: number;
	private readonly principalId: string;
	private readonly now: () => number;
	private readonly appendQueues = new Map<string, Promise<void>>();
	private readonly active = new Map<string, ActiveTurn>();

	constructor(options: AgentKernelOptions) {
		this.sessionStore = options.sessionStore;
		this.adapter = options.adapter;
		this.dispatcher = options.dispatcher;
		this.model = options.model ?? "default";
		this.tools = options.tools ?? [];
		this.budgets = options.budgets ?? {};
		this.maxRetries = options.maxRetries ?? 0;
		if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 8)
			throw new AgentKernelError("INVALID_CONTRACT", "maxRetries must be an integer from 0 to 8");
		this.principalId = options.principalId ?? "agent-kernel";
		this.now = options.now ?? Date.now;
		for (const [name, value] of Object.entries(this.budgets)) {
			if (value !== undefined && (!Number.isFinite(value) || value < 0))
				throw new AgentKernelError("INVALID_CONTRACT", `${name} must be non-negative`);
		}
	}

	async startTurn(input: StartTurnInput): Promise<AcceptedTurn> {
		const state = await this.sessionStore.fold(input.sessionId);
		if (state.closed) throw new AgentKernelError("SESSION_CLOSED", `session ${input.sessionId} is closed`);
		const turnId = input.turnId ?? randomUUID();
		await this.append(input.sessionId, [
			this.event(input.sessionId, "turn.started", { turnId }, turnId, turnId),
			this.event(input.sessionId, "message.user", input.content, `${turnId}:user`, turnId),
		]);
		if (input.signal?.aborted) await this.cancelTurn(input.sessionId, turnId, "cancelled before execution");
		return { sessionId: input.sessionId, turnId, accepted: true };
	}

	async executeTurn(input: ExecuteTurnInput): Promise<CompletedTurn> {
		const events = await this.readEvents(input.sessionId);
		const existing = findTurnCompleted(events, input.turnId);
		if (existing) return this.completedFromEvent(input.sessionId, input.turnId, existing);
		const content = input.content ?? this.userContent(events, input.turnId);
		if (content === undefined)
			throw new AgentKernelError("INVALID_CONTRACT", `turn ${input.turnId} has no user message`);
		const controller = new AbortController();
		const active: ActiveTurn = { controller, startedAt: this.now() };
		const relay = (): void => controller.abort(input.signal?.reason ?? "cancelled");
		if (input.signal) {
			if (input.signal.aborted) relay();
			else input.signal.addEventListener("abort", relay, { once: true });
		}
		let deadline: ReturnType<typeof setTimeout> | undefined;
		if (this.budgets.maxDurationMs !== undefined) {
			deadline = setTimeout(() => controller.abort("timeout"), this.budgets.maxDurationMs);
		}
		this.active.set(this.activeKey(input.sessionId, input.turnId), active);
		try {
			const result = await this.runLoop(input.sessionId, input.turnId, content, controller, active.startedAt);
			return result;
		} catch (error) {
			const kernelError = controller.signal.aborted
				? controller.signal.reason === "timeout"
					? new AgentKernelError("TIMEOUT", "turn time budget exceeded")
					: new AgentKernelError("CANCELLED", "turn was cancelled")
				: errorFor(error);
			if (kernelError.code === "BUDGET_EXCEEDED" || kernelError.code === "TIMEOUT")
				await this.recordBudgetExhausted(input.sessionId, input.turnId, kernelError);
			await this.completeTurn(
				input.sessionId,
				input.turnId,
				kernelError.code === "CANCELLED" ? "cancelled" : "failed",
				kernelError,
			);
			return {
				sessionId: input.sessionId,
				turnId: input.turnId,
				status: kernelError.code === "CANCELLED" ? "cancelled" : "failed",
				error: kernelError,
			};
		} finally {
			if (deadline) clearTimeout(deadline);
			if (input.signal) input.signal.removeEventListener("abort", relay);
			this.active.delete(this.activeKey(input.sessionId, input.turnId));
		}
	}

	async steer(sessionId: string, turnId: string, content: SessionJsonValue): Promise<void> {
		await this.append(sessionId, [
			this.event(sessionId, "steering.received", content, `${turnId}:steer:${randomUUID()}`, turnId, "operational", {
				principal: true,
			}),
		]);
	}

	async cancel(sessionId: string, turnId: string, reason = "cancelled by caller"): Promise<void> {
		const active = this.active.get(this.activeKey(sessionId, turnId));
		active?.controller.abort(reason);
		await this.cancelTurn(sessionId, turnId, reason);
	}

	async recover(sessionId: string): Promise<RecoveryResult> {
		const state = await this.sessionStore.fold(sessionId);
		if (!state.activeTurnId) return { sessionId, recoveredTurnIds: [], failedTurnIds: [] };
		const turnId = state.activeTurnId;
		const events = await this.readEvents(sessionId);
		const user = this.userContent(events, turnId);
		if (user === undefined) return { sessionId, recoveredTurnIds: [], failedTurnIds: [] };
		const result = await this.executeTurn({ sessionId, turnId, content: user });
		return {
			sessionId,
			recoveredTurnIds: result.status === "completed" ? [turnId] : [],
			failedTurnIds: result.status === "completed" ? [] : [turnId],
		};
	}

	private async runLoop(
		sessionId: string,
		turnId: string,
		userContent: SessionJsonValue,
		controller: AbortController,
		startedAt: number,
	): Promise<CompletedTurn> {
		const usage: TurnUsage = {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsd: 0,
			steps: 0,
			toolCalls: 0,
			outputBytes: 0,
		};
		for (;;) {
			this.throwIfAborted(controller);
			const events = await this.readEvents(sessionId);
			if (findTurnCompleted(events, turnId))
				return this.completedFromEvent(sessionId, turnId, findTurnCompleted(events, turnId) as AgentSessionEvent);
			const acceptedToolCalls = events.filter((event) => event.turnId === turnId && event.kind === "tool.call.started");
			const incompleteToolCall = acceptedToolCalls.find((started) => {
				const callId = objectValue(started.payload)?.id;
				return !events.some(
					(event) =>
						(event.kind === "tool.call.completed" || event.kind === "tool.call.failed") &&
						event.turnId === turnId &&
						objectValue(event.payload)?.id === callId,
				);
			});
			if (incompleteToolCall)
				throw new AgentKernelError("RECOVERY_INCOMPLETE_CALL", "an accepted tool call has no terminal fact");
			const step = events.filter((event) => event.turnId === turnId && event.kind === "model.completed").length + 1;
			usage.steps = step;
			checkBudget(this.budgets, usage, startedAt, this.now);
			const priorStream = events.filter(
				(event) =>
					event.turnId === turnId && event.kind === "model.stream" && objectValue(event.payload)?.step === step,
			);
			const modelCallStarted = events.find(
				(event) =>
					event.turnId === turnId && event.kind === "model.call.started" && objectValue(event.payload)?.step === step,
			);
			let response: AssembledModelResponse;
			if (priorStream.length > 0) {
				const assembler = new ModelStreamAssembler({ maxOutputBytes: this.budgets.maxOutputBytes });
				for (const event of priorStream) {
					const chunk = payloadChunk(event);
					if (chunk) assembler.add(chunk);
				}
				response = assembler.finish();
			} else {
				if (modelCallStarted)
					throw new AgentKernelError("RECOVERY_INCOMPLETE_CALL", `model call for step ${step} was already accepted`);
				await this.append(sessionId, [
					this.event(
						sessionId,
						"model.call.started",
						{ step, model: this.model },
						`${turnId}:model:started:${step}`,
						turnId,
						"operational",
						{ idempotencyKey: `${turnId}:model:${step}` },
					),
				]);
				const messages = this.messagesForRequest(events, turnId, userContent);
				const request: ModelRequest = {
					contractVersion: "1",
					idempotencyKey: `${turnId}:model:${step}`,
					model: this.model,
					messages,
					tools: this.tools,
					...(this.budgets.maxTokens === undefined
						? {}
						: {
								maxOutputTokens: Math.max(1, Math.floor(budgetRemaining(this.budgets, usage, "maxTokens") ?? 1)),
							}),
					signal: controller.signal,
				};
				let retries = 0;
				for (;;) {
					const assembler = new ModelStreamAssembler({ maxOutputBytes: this.budgets.maxOutputBytes });
					try {
						for await (const rawChunk of this.adapter.stream(request)) {
							this.throwIfAborted(controller);
							const chunk = parseModelStreamChunk(rawChunk);
							assembler.add(chunk);
							await this.append(sessionId, [
								this.event(
									sessionId,
									"model.stream",
									{ step, chunk: chunkEventPayload(chunk) },
									`${turnId}:stream:${step}:${chunk.index}`,
									turnId,
								),
							]);
						}
						response = assembler.finish();
						break;
					} catch (error) {
						if (error instanceof AgentKernelError) throw error;
						const providerError = errorFor(error);
						if (
							assembler.chunkCount > 0 ||
							retries >= this.maxRetries ||
							!["RATE_LIMIT", "PROVIDER_DISCONNECT"].includes(providerError.code)
						)
							throw providerError;
						retries += 1;
					}
				}
			}
			const responseContent =
				response.toolCalls.length === 0 && response.content.length === 0 ? response.text : response.content;
			if (!SessionJsonValueSchema.safeParse(responseContent).success)
				throw new AgentKernelError("INVALID_CONTRACT", "model response content is not a session JSON value");
			const responseUsage = usageFromResponse(response);
			addUsage(usage, responseUsage);
			checkBudget(this.budgets, usage, startedAt, this.now);
			await this.recordBudget(sessionId, turnId, usage);
			const assistantBlocks: ModelContentBlock[] = [
				...(response.text ? [{ type: "text" as const, text: response.text }] : []),
				...response.content,
				...response.toolCalls.map((call) => ({ type: "tool-call" as const, ...call })),
			];
			await this.append(sessionId, [
				this.event(
					sessionId,
					"model.completed",
					{ step, finishReason: response.finishReason, usage: response.usage, toolCalls: response.toolCalls },
					`${turnId}:model:${step}`,
					turnId,
				),
				this.event(
					sessionId,
					"message.assistant",
					{ blocks: assistantBlocks, text: response.text },
					`${turnId}:assistant:${step}`,
					turnId,
				),
			]);
			if (response.toolCalls.length === 0) {
				await this.completeTurn(
					sessionId,
					turnId,
					"completed",
					undefined,
					response.text ? jsonValue(response.text) : undefined,
				);
				return {
					sessionId,
					turnId,
					status: "completed",
					...(response.text ? { content: jsonValue(response.text) } : {}),
				};
			}
			if (!this.dispatcher)
				throw new AgentKernelError("TOOL_FAILED", "model requested a tool but no dispatcher is configured");
			for (const call of response.toolCalls) {
				this.throwIfAborted(controller);
				usage.toolCalls += 1;
				checkBudget(this.budgets, usage, startedAt, this.now);
				const definition = this.tools.find((tool) => tool.name === call.name);
				if (!definition) throw new AgentKernelError("MALFORMED_TOOL_CALL", `model requested unknown tool ${call.name}`);
				const idempotencyKey = `${turnId}:tool:${step}:${call.id}`;
				const existingCall = events.find(
					(event) => event.kind === "tool.call.started" && event.idempotencyKey === idempotencyKey,
				);
				if (existingCall)
					throw new AgentKernelError("RECOVERY_INCOMPLETE_CALL", `tool call ${call.id} was already accepted`);
				await this.append(sessionId, [
					this.event(
						sessionId,
						"tool.call.started",
						{ id: call.id, name: call.name, arguments: call.arguments, step },
						idempotencyKey,
						turnId,
						"operational",
						{ idempotencyKey },
					),
				]);
				let result: Awaited<ReturnType<AgentDispatcher["dispatch"]>>;
				try {
					const toolRequest: AgentToolRequest = {
						id: call.id,
						name: call.name,
						arguments: call.arguments,
						definition,
						sessionId,
						turnId,
						step,
						idempotencyKey,
						signal: controller.signal,
					};
					result = await this.dispatcher.dispatch(toolRequest);
					if (!SessionJsonValueSchema.safeParse(result.content).success)
						throw new AgentKernelError("INVALID_CONTRACT", `tool ${call.name} returned a non-JSON result`);
				} catch (error) {
					const toolError =
						error instanceof AgentKernelError
							? error
							: new AgentKernelError("TOOL_FAILED", `tool ${call.name} failed`, error);
					await this.append(sessionId, [
						this.event(
							sessionId,
							"tool.call.failed",
							{ id: call.id, name: call.name, code: toolError.code, message: toolError.message },
							`${idempotencyKey}:failed`,
							turnId,
							"operational",
							{},
						),
					]);
					throw toolError;
				}
				await this.append(sessionId, [
					this.event(
						sessionId,
						"tool.call.completed",
						{ id: call.id, name: call.name, workflowRunId: result.workflowRunId, isError: result.isError === true },
						`${idempotencyKey}:completed`,
						turnId,
						"operational",
						{},
					),
					this.event(
						sessionId,
						"message.tool",
						{
							toolCallId: call.id,
							name: call.name,
							content: result.content,
							...(result.isError === true ? { isError: true } : {}),
						},
						`${idempotencyKey}:message`,
						turnId,
					),
				]);
			}
		}
	}

	private messagesForRequest(
		events: readonly AgentSessionEvent[],
		turnId: string,
		userContent: SessionJsonValue,
	): readonly ModelMessage[] {
		const messages = events
			.filter((event) => event.visibility === "model-visible" && event.turnId !== undefined)
			.map((event) => {
				if (event.kind === "message.user" || event.kind === "message.assistant" || event.kind === "message.tool") {
					return roleForMessage({
						id: event.id,
						turnId: event.turnId,
						role: event.kind.split(".")[1] as SessionMessage["role"],
						content: event.payload,
						sequence: event.sequence,
					});
				}
				return undefined;
			})
			.filter((message): message is ModelMessage => message !== undefined);
		const steering = events
			.filter((event) => event.kind === "steering.received" && event.turnId === turnId)
			.map((event) => ({ role: "user" as const, content: [{ type: "json" as const, value: event.payload }] }));
		return messages.length === 0
			? [{ role: "user", content: [{ type: "json", value: userContent }] }, ...steering]
			: [...messages, ...steering];
	}

	private async recordBudget(sessionId: string, turnId: string, usage: TurnUsage): Promise<void> {
		const values: Array<[string, number | undefined]> = [
			["tokens", budgetRemaining(this.budgets, usage, "maxTokens")],
			["costUsd", budgetRemaining(this.budgets, usage, "maxCostUsd")],
			["steps", budgetRemaining(this.budgets, usage, "maxSteps")],
			["toolCalls", budgetRemaining(this.budgets, usage, "maxToolCalls")],
			["outputBytes", budgetRemaining(this.budgets, usage, "maxOutputBytes")],
		];
		const events: SessionEventInput[] = [];
		for (const [name, remaining] of values) {
			if (remaining !== undefined)
				events.push(
					this.event(
						sessionId,
						"budget.updated",
						{ name, remaining },
						`${turnId}:budget:${name}:${usage.steps}`,
						turnId,
					),
				);
		}
		if (events.length > 0) await this.append(sessionId, events);
	}

	private async recordBudgetExhausted(sessionId: string, turnId: string, error: AgentKernelError): Promise<void> {
		await this.append(sessionId, [
			this.event(
				sessionId,
				"budget.exhausted",
				{ name: "turn", remaining: 0, code: error.code, message: error.message },
				`${turnId}:budget:exhausted`,
				turnId,
			),
		]);
	}

	private async completeTurn(
		sessionId: string,
		turnId: string,
		status: "completed" | "failed" | "cancelled",
		error?: AgentKernelError,
		content?: SessionJsonValue,
	): Promise<void> {
		const events = await this.readEvents(sessionId);
		if (findTurnCompleted(events, turnId)) return;
		await this.append(sessionId, [
			this.event(
				sessionId,
				"turn.completed",
				{
					status,
					...(content === undefined ? {} : { content }),
					...(error ? { error: { code: error.code, message: error.message } } : {}),
				},
				`${turnId}:completed`,
				turnId,
			),
		]);
	}

	private async cancelTurn(sessionId: string, turnId: string, reason: string): Promise<void> {
		await this.completeTurn(sessionId, turnId, "cancelled", new AgentKernelError("CANCELLED", reason));
	}

	private completedFromEvent(sessionId: string, turnId: string, event: AgentSessionEvent): CompletedTurn {
		const payload = objectValue(event.payload);
		const status = payload?.status;
		if (status !== "completed" && status !== "failed" && status !== "cancelled")
			throw new AgentSessionContractError("turn.completed has an invalid status");
		const errorValue = objectValue(payload?.error ?? null);
		const error =
			errorValue && typeof errorValue.code === "string" && typeof errorValue.message === "string"
				? new AgentKernelError(errorValue.code as AgentKernelError["code"], errorValue.message)
				: undefined;
		return {
			sessionId,
			turnId,
			status,
			...(payload?.content === undefined ? {} : { content: payload.content }),
			...(error ? { error } : {}),
		};
	}

	private userContent(events: readonly AgentSessionEvent[], turnId: string): SessionJsonValue | undefined {
		return events.find((event) => event.turnId === turnId && event.kind === "message.user")?.payload;
	}

	private async readEvents(sessionId: string): Promise<readonly AgentSessionEvent[]> {
		const page = await this.sessionStore.read(sessionId, { afterSequence: 0, limit: 256 });
		if (page.corruptTail)
			throw new AgentSessionContractError(`session has corrupt tail at ${page.corruptTail.sequence}`);
		const events = [...page.events];
		let cursor = page.nextCursor;
		while (cursor) {
			const next = await this.sessionStore.read(sessionId, cursor);
			events.push(...next.events);
			cursor = next.nextCursor;
		}
		return events;
	}

	private event(
		sessionId: string,
		kind: AgentSessionEventKind,
		payload: unknown,
		key: string,
		turnId?: string,
		visibility: AgentSessionEventVisibility = kind.startsWith("message.") ? "model-visible" : "operational",
		options: { readonly idempotencyKey?: string; readonly principal?: boolean } = {},
	): SessionEventInput {
		return {
			contractVersion: "1",
			schemaVersion: 1,
			id: `${sessionId}:${key}`,
			sessionId,
			...(turnId ? { turnId } : {}),
			kind,
			visibility,
			actor: options.principal ? { kind: "user", id: this.principalId } : agentActor,
			...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
			occurredAt: new Date(this.now()).toISOString(),
			payload: jsonValue(payload),
		};
	}

	private async append(sessionId: string, events: readonly SessionEventInput[]): Promise<void> {
		const previous = this.appendQueues.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => current);
		this.appendQueues.set(sessionId, queued);
		await previous;
		try {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					const state: SessionState = await this.sessionStore.fold(sessionId);
					await this.sessionStore.append({ sessionId, expectedSequence: state.lastSequence, events });
					return;
				} catch (error) {
					if (!(error instanceof SessionConcurrencyError) || attempt === 2) throw error;
				}
			}
		} finally {
			release();
			if (this.appendQueues.get(sessionId) === queued) this.appendQueues.delete(sessionId);
		}
	}

	private activeKey(sessionId: string, turnId: string): string {
		return `${sessionId}:${turnId}`;
	}

	private throwIfAborted(controller: AbortController): void {
		if (!controller.signal.aborted) return;
		const code = controller.signal.reason === "timeout" ? "TIMEOUT" : "CANCELLED";
		throw new AgentKernelError(code, code === "TIMEOUT" ? "turn time budget exceeded" : "turn was cancelled");
	}
}

export function createAgentKernel(options: AgentKernelOptions): AgentKernel {
	return new AgentKernel(options);
}
