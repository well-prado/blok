import { randomUUID } from "node:crypto";
import { AgentKernel, type ModelAdapter } from "@blokjs/agent-kernel";
import type { WorkspaceWriteResult } from "@blokjs/capabilities";
import type { CodeModeGeneratedSurface, CodeModePhase } from "@blokjs/code-mode";
import { HarnessControlPlaneServer, type HarnessControlPlaneServerHandle } from "@blokjs/control-plane";
import type {
	ControlPlaneEvent,
	CreateSessionRequest,
	StartWorkflowRequest,
	StreamEventsRequest,
} from "@blokjs/control-plane";
import { InMemoryInteractionStore } from "@blokjs/runner";
import type {
	AgentSessionEvent,
	AuthoritativeSourceReader,
	CapabilityEffect,
	CapabilityManifestV1,
	GitCapability,
	GitCapabilityRequest,
	GitRepositoryIdentity,
	GitRevisionIdentity,
	GitWorktreeIdentity,
	GraphProvider,
	GraphScope,
	InteractionStatus,
	PolicyContext,
	PolicyEvaluationResult,
	PolicyProvider,
	PolicyRequest,
	ProcessCapability,
	ProcessSpec,
	SessionEventInput,
	SessionJsonValue,
	SessionStore,
} from "@blokjs/shared";
import { assertProcessStartResult, capabilityScope, parseProcessResult, parseProcessSpec } from "@blokjs/shared";
import type { InteractionRecord, InteractionStore } from "@blokjs/shared";

export const CODING_HARNESS_WORKFLOW_NAME = "strict-coding-reference" as const;
export const CODING_HARNESS_PHASES = ["understand", "plan", "approve", "implement", "test", "review"] as const;
export type CodingHarnessPhase = (typeof CODING_HARNESS_PHASES)[number];
export type CodingHarnessTerminalState = "completed" | "failed" | "cancelled";

export interface CodingHarnessTaskInput {
	readonly taskId: string;
	readonly objective: string;
	readonly repository: GitRepositoryIdentity;
	readonly base?: GitRevisionIdentity;
	readonly branch?: string;
	readonly sourcePaths?: readonly string[];
}

export interface CodingHarnessWorkflowInput extends CodingHarnessTaskInput {
	readonly sessionId?: string;
}

export interface CodingHarnessPolicyDecision {
	readonly phase: CodingHarnessPhase;
	readonly capability: string;
	readonly decision: PolicyEvaluationResult["decision"];
	readonly matchedRules: PolicyEvaluationResult["matchedRules"];
}

export interface CodingHarnessEvidence {
	readonly producer: "trusted-process";
	readonly status: "passed" | "failed" | "cancelled";
	readonly command: readonly string[];
	readonly exitCode?: number;
	readonly signal?: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly capturedAt: string;
}

export interface CodingHarnessState {
	readonly sessionId: string;
	readonly taskId: string;
	readonly objective: string;
	readonly phase: CodingHarnessPhase | "complete" | "failed" | "cancelled";
	readonly phaseStatus: "pending" | "running" | "awaiting-approval" | "completed" | "failed" | "cancelled";
	readonly workflowRunId?: string;
	readonly activeTurnId?: string;
	readonly worktree?: GitWorktreeIdentity;
	readonly approval?: {
		readonly interactionId: string;
		readonly status: InteractionRecord["status"];
		readonly sequence: number;
	};
	readonly graphFallback?: {
		readonly reason: string;
		readonly paths: readonly string[];
	};
	readonly decisions: readonly CodingHarnessPolicyDecision[];
	readonly evidence?: CodingHarnessEvidence;
	readonly diff?: unknown;
	readonly stream: readonly AgentSessionEvent[];
	readonly terminal?: { readonly status: CodingHarnessTerminalState; readonly message?: string };
}

export interface CodingHarnessImplementationInput {
	readonly task: CodingHarnessWorkflowInput;
	readonly worktree: GitWorktreeIdentity;
	readonly plan: SessionJsonValue;
	readonly signal: AbortSignal;
	readonly owner: GitCapabilityRequest["owner"];
	readonly policy: PolicyRequest;
}

export interface CodingHarnessImplementationOutput {
	readonly writes: readonly WorkspaceWriteResult[];
	readonly artifact?: SessionJsonValue;
}

export interface CodingHarnessPorts {
	readonly sessionStore: SessionStore;
	readonly interactionStore?: InteractionStore;
	readonly git: GitCapability;
	readonly graph: GraphProvider;
	readonly source: AuthoritativeSourceReader;
	readonly process: ProcessCapability;
	readonly policy: PolicyProvider;
	readonly testSpec: (input: {
		readonly worktree: GitWorktreeIdentity;
		readonly task: CodingHarnessWorkflowInput;
	}) => ProcessSpec;
	readonly implement: (input: CodingHarnessImplementationInput) => Promise<CodingHarnessImplementationOutput>;
	/** Generated Code Mode surfaces are the only model-visible tool catalog. */
	/** Surfaces are generated for the Code Mode phase names; legacy harness phase keys remain accepted. */
	readonly codeModeSurfaces?: Partial<Record<CodeModePhase | CodingHarnessPhase, CodeModeGeneratedSurface>>;
	readonly modelAdapter?: ModelAdapter;
	readonly agentKernel?: AgentKernel;
	readonly principal?: { readonly id: string; readonly kind: string };
	readonly now?: () => string;
}

export interface CodingHarnessServerOptions extends CodingHarnessPorts {
	readonly listenAddress?: string;
	readonly token?: string;
	readonly closeStoreOnStop?: boolean;
}

export interface CodingHarnessServer {
	readonly server: HarnessControlPlaneServerHandle;
	readonly runtime: CodingHarnessRuntime;
}

export interface CodingHarnessClientPort {
	createSession(input: CreateSessionRequest): Promise<{ readonly sessionId: string }>;
	startWorkflow(sessionId: string, input: StartWorkflowRequest): Promise<{ readonly workflowRunId: string }>;
	streamEvents(
		input: StreamEventsRequest,
		options?: { readonly signal?: AbortSignal },
	): AsyncIterable<ControlPlaneEvent>;
	inspectSession(input: { readonly sessionId: string }): Promise<{
		readonly sessionId: string;
		readonly state?: unknown;
	}>;
	answerInteraction(
		sessionId: string,
		input: {
			readonly interactionId: string;
			readonly sequence: number;
			readonly answer?: SessionJsonValue;
			readonly deny?: boolean;
		},
	): Promise<unknown>;
	resume(sessionId: string, input: { readonly interactionId: string; readonly sequence: number }): Promise<unknown>;
	cancel(
		sessionId: string,
		input: { readonly target: "session" | "turn" | "workflow"; readonly targetId?: string; readonly reason?: string },
	): Promise<unknown>;
}

export interface CodingHarnessRun {
	readonly sessionId: string;
	readonly workflowRunId: string;
	readonly state: CodingHarnessState;
	readonly events: readonly ControlPlaneEvent[];
}

export interface CodingHarnessApprovalRequest {
	readonly sessionId: string;
	readonly interactionId: string;
	readonly sequence: number;
	readonly plan?: SessionJsonValue;
}

function asJson(value: unknown): SessionJsonValue {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("coding harness fact is not JSON serializable");
	return JSON.parse(serialized) as SessionJsonValue;
}

function objectPayload(value: SessionJsonValue): Readonly<Record<string, SessionJsonValue>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, SessionJsonValue>>)
		: undefined;
}

function stringValue(value: SessionJsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function eventInteractionId(
	event: AgentSessionEvent | ControlPlaneEvent,
	payload = objectPayload(event.payload),
): string | undefined {
	if ("interactionId" in event && typeof event.interactionId === "string") return event.interactionId;
	return stringValue(payload?.interactionId);
}

function phaseValue(value: SessionJsonValue | undefined): CodingHarnessPhase | undefined {
	const phase = stringValue(value);
	return phase && (CODING_HARNESS_PHASES as readonly string[]).includes(phase)
		? (phase as CodingHarnessPhase)
		: undefined;
}

function codeModePhase(phase: Extract<CodingHarnessPhase, "plan" | "implement" | "test" | "review">): CodeModePhase {
	switch (phase) {
		case "plan":
			return "planning";
		case "implement":
			return "implementing";
		case "test":
			return "testing";
		case "review":
			return "review";
	}
}

function phaseManifest(
	capability: string,
	effects: readonly CapabilityEffect[],
	deterministic = false,
): CapabilityManifestV1 {
	return {
		version: "1",
		classification: "agent-compatible",
		effects: [...effects],
		capabilities: [capability],
		secrets: [],
		determinism: deterministic ? "deterministic" : "external",
		idempotency: capability === "workspace.write" ? "conditionally-idempotent" : "idempotent",
		maturity: "stable",
	};
}

function policyRequest(input: {
	sessionId: string;
	task: CodingHarnessWorkflowInput;
	phase: CodingHarnessPhase;
	step: string;
	capability: string;
	effects: readonly CapabilityEffect[];
	turnId?: string;
	signal?: AbortSignal;
	approval?: PolicyContext["approval"];
}): PolicyRequest {
	const principal = { id: input.task.taskId, kind: "desktop-task" };
	return {
		requestId: randomUUID(),
		origin: "agent",
		principal,
		session: { id: input.sessionId },
		turn: { id: input.turnId ?? `${input.task.taskId}:${input.phase}` },
		workflow: { name: CODING_HARNESS_WORKFLOW_NAME, version: "1.0.0" },
		step: { id: input.step },
		manifest: phaseManifest(input.capability, input.effects, input.phase === "test" || input.phase === "approve"),
		scope: capabilityScope(input.effects, [input.capability]),
		layers: [],
		...(input.signal ? { signal: input.signal } : {}),
		...(input.approval ? { approval: input.approval } : {}),
	};
}

function eventInput(
	sessionId: string,
	id: string,
	kind: SessionEventInput["kind"],
	payload: SessionJsonValue,
	options: {
		readonly turnId?: string;
		readonly workflowRunId?: string;
		readonly interactionId?: string;
		readonly visibility?: SessionEventInput["visibility"];
		readonly actor?: SessionEventInput["actor"];
	} = {},
): SessionEventInput {
	return {
		contractVersion: "1",
		schemaVersion: 1,
		id,
		sessionId,
		kind,
		visibility: options.visibility ?? "operational",
		actor: options.actor ?? { kind: "agent", id: "desktop-harness" },
		...(options.turnId ? { turnId: options.turnId } : {}),
		...(options.workflowRunId ? { workflowRunId: options.workflowRunId } : {}),
		...(options.interactionId ? { interactionId: options.interactionId } : {}),
		occurredAt: new Date().toISOString(),
		idempotencyKey: id,
		payload,
	};
}

function phaseCompleted(
	events: readonly AgentSessionEvent[],
	phase: CodingHarnessPhase,
	workflowRunId?: string,
): AgentSessionEvent | undefined {
	return [...events].reverse().find((event) => {
		const payload = objectPayload(event.payload);
		return (
			event.kind === "workflow.run.completed" &&
			phaseValue(payload?.phase) === phase &&
			(workflowRunId === undefined || stringValue(payload?.workflowRunId) === workflowRunId)
		);
	});
}

function workflowTerminal(events: readonly AgentSessionEvent[], workflowRunId: string): AgentSessionEvent | undefined {
	return [...events].reverse().find((event) => {
		const payload = objectPayload(event.payload);
		return (
			((event.kind === "workflow.run.completed" && payload?.phase === "complete") ||
				event.kind === "workflow.run.failed") &&
			stringValue(payload?.workflowRunId) === workflowRunId
		);
	});
}

function latestRunId(events: readonly AgentSessionEvent[]): string | undefined {
	for (const event of [...events].reverse()) {
		const payload = objectPayload(event.payload);
		const runId = stringValue(payload?.workflowRunId);
		if (runId) return runId;
	}
	return undefined;
}

function eventMessage(error: unknown): string {
	return error instanceof Error ? error.message : "coding harness operation failed";
}

function modelTools(
	surface: CodeModeGeneratedSurface | undefined,
): readonly import("@blokjs/agent-kernel").ModelToolDefinition[] {
	return (surface?.bindings ?? []).map((binding) => ({
		name: binding.stableName,
		description: binding.descriptor.description,
		inputSchema: asJson(binding.descriptor.inputSchema),
		kind: binding.descriptor.kind,
		...(binding.descriptor.kind === "workflow" ? { workflowName: binding.descriptor.id } : {}),
	}));
}

export class CodingHarnessRuntime {
	private readonly interactions: InteractionStore;
	private readonly now: () => string;
	private readonly appendQueues = new Map<string, Promise<void>>();
	private readonly kernel?: AgentKernel;

	constructor(private readonly ports: CodingHarnessPorts) {
		this.interactions = ports.interactionStore ?? new InMemoryInteractionStore();
		this.now = ports.now ?? (() => new Date().toISOString());
		if (!ports.agentKernel && ports.modelAdapter) {
			// The default kernel is used by direct turn requests. Workflow model
			// phases create a phase-scoped kernel below, so the model never sees a
			// binding from another Code Mode phase.
			this.kernel = this.createKernel("planning");
		}
		this.kernel = ports.agentKernel ?? this.kernel;
	}

	private createKernel(phase: CodeModePhase): AgentKernel | undefined {
		if (!this.ports.modelAdapter) return undefined;
		const surface =
			this.ports.codeModeSurfaces?.[phase] ?? this.ports.codeModeSurfaces?.[phase === "planning" ? "plan" : phase];
		return new AgentKernel({
			sessionStore: this.ports.sessionStore,
			adapter: this.ports.modelAdapter,
			tools: modelTools(surface),
			dispatcher: {
				dispatch: async (request: import("@blokjs/agent-kernel").AgentToolRequest) => {
					const binding = Object.values(this.ports.codeModeSurfaces ?? {})
						.flatMap((item) => item?.bindings ?? [])
						.find((item) => item.stableName === request.name);
					if (!binding) throw new Error(`generated Code Mode binding ${request.name} is unavailable`);
					return { content: asJson(await binding.invoke(request.arguments)) };
				},
			},
		});
	}

	private kernelForPhase(phase: Extract<CodingHarnessPhase, "plan" | "implement" | "review">): AgentKernel | undefined {
		return this.ports.agentKernel ?? this.createKernel(codeModePhase(phase));
	}

	async executeTurn(input: {
		readonly sessionId: string;
		readonly turnId: string;
		readonly content: SessionJsonValue;
		readonly signal: AbortSignal;
	}): Promise<{ readonly content: SessionJsonValue }> {
		if (!this.kernel) return { content: input.content };
		const result = await this.kernel.executeTurn(input);
		if (result.status !== "completed") throw result.error ?? new Error(`turn ${result.status}`);
		return { content: result.content ?? null };
	}

	async executeWorkflow(input: {
		readonly sessionId: string;
		readonly workflowRunId: string;
		readonly workflowName: string;
		readonly input: SessionJsonValue | undefined;
		readonly signal: AbortSignal;
	}): Promise<{ readonly output?: SessionJsonValue }> {
		return this.executeWorkflowInternal(input, false);
	}

	private async executeWorkflowInternal(
		input: {
			readonly sessionId: string;
			readonly workflowRunId: string;
			readonly workflowName: string;
			readonly input: SessionJsonValue | undefined;
			readonly signal: AbortSignal;
		},
		fromRecovery: boolean,
	): Promise<{ readonly output?: SessionJsonValue }> {
		if (input.workflowName !== CODING_HARNESS_WORKFLOW_NAME)
			throw new Error(`unsupported coding harness workflow ${input.workflowName}`);
		const task = this.parseTask(input.input);
		try {
			const events = await this.readEvents(input.sessionId);
			const terminal = workflowTerminal(events, input.workflowRunId);
			const terminalPayload = objectPayload(terminal?.payload ?? null);
			const canResumeCancelledApproval =
				fromRecovery &&
				terminalPayload?.status === "cancelled" &&
				(await this.recoverableApproval(events, input.workflowRunId));
			if (terminal && !canResumeCancelledApproval) {
				const payload = objectPayload(terminal.payload);
				return { output: payload?.output };
			}
			const output = await this.runPhases(input.sessionId, input.workflowRunId, task, events, input.signal);
			await this.append(input.sessionId, [
				eventInput(input.sessionId, `${input.workflowRunId}:terminal:complete`, "workflow.run.completed", {
					workflowRunId: input.workflowRunId,
					phase: "complete",
					status: "completed",
					output,
				}),
			]);
			return { output };
		} catch (error: unknown) {
			const cancelled = input.signal.aborted;
			await this.append(input.sessionId, [
				eventInput(
					input.sessionId,
					`${input.workflowRunId}:terminal:${cancelled ? "cancelled" : "failed"}`,
					"workflow.run.failed",
					{
						workflowRunId: input.workflowRunId,
						status: cancelled ? "cancelled" : "failed",
						message: eventMessage(error),
					},
				),
			]);
			throw error;
		}
	}

	async recoverSession(sessionId: string, signal = new AbortController().signal): Promise<void> {
		const events = await this.readEvents(sessionId);
		const started = [...events].reverse().find((event) => {
			if (event.kind !== "workflow.run.started") return false;
			return objectPayload(event.payload)?.input !== undefined;
		});
		if (!started) return;
		const payload = objectPayload(started.payload);
		const workflowRunId = stringValue(payload?.workflowRunId) ?? latestRunId(events);
		const input = payload?.input;
		if (!workflowRunId || input === undefined) return;
		const terminal = workflowTerminal(events, workflowRunId);
		if (terminal) {
			const terminalPayload = objectPayload(terminal.payload);
			if (terminalPayload?.status !== "cancelled" || !(await this.recoverableApproval(events, workflowRunId))) return;
		}
		await this.executeWorkflowInternal(
			{
				sessionId,
				workflowRunId,
				workflowName: CODING_HARNESS_WORKFLOW_NAME,
				input,
				signal,
			},
			true,
		);
	}

	private async recoverableApproval(events: readonly AgentSessionEvent[], workflowRunId: string): Promise<boolean> {
		const requested = [...events]
			.reverse()
			.find(
				(event) =>
					event.kind === "approval.requested" &&
					stringValue(objectPayload(event.payload)?.workflowRunId) === workflowRunId &&
					event.interactionId !== undefined,
			);
		if (!requested?.interactionId) return false;
		return (await this.interactions.get(requested.interactionId))?.status === "answered";
	}

	private parseTask(input: SessionJsonValue | undefined): CodingHarnessWorkflowInput {
		const value = objectPayload(input ?? null);
		if (!value || typeof value.taskId !== "string" || typeof value.objective !== "string" || !value.repository)
			throw new Error("coding harness workflow input must include taskId, objective, and repository");
		return {
			taskId: value.taskId,
			objective: value.objective,
			repository: value.repository as unknown as GitRepositoryIdentity,
			...(value.base && typeof value.base === "object" && !Array.isArray(value.base)
				? { base: value.base as unknown as GitRevisionIdentity }
				: {}),
			...(typeof value.branch === "string" ? { branch: value.branch } : {}),
			...(Array.isArray(value.sourcePaths)
				? { sourcePaths: value.sourcePaths.filter((path): path is string => typeof path === "string") }
				: {}),
		};
	}

	private async runPhases(
		sessionId: string,
		workflowRunId: string,
		task: CodingHarnessWorkflowInput,
		initialEvents: readonly AgentSessionEvent[],
		signal: AbortSignal,
	): Promise<SessionJsonValue> {
		let events = initialEvents;
		const repository = await this.inspectRepository(sessionId, task, signal);
		const context = await this.understandRepository(sessionId, task, repository, workflowRunId, signal);
		events = await this.readEvents(sessionId);
		const plan = await this.modelPhase(sessionId, workflowRunId, "plan", task.objective, context, events, signal);
		events = await this.readEvents(sessionId);
		await this.approve(sessionId, workflowRunId, task, plan, events, signal);
		events = await this.readEvents(sessionId);
		const worktree = await this.implement(sessionId, workflowRunId, task, repository, plan, events, signal);
		events = await this.readEvents(sessionId);
		const evidence = await this.test(sessionId, workflowRunId, task, worktree, events, signal);
		events = await this.readEvents(sessionId);
		const diff = await this.review(
			sessionId,
			workflowRunId,
			task,
			repository,
			worktree,
			plan,
			evidence,
			events,
			signal,
		);
		return asJson({ phase: "complete", worktree, evidence, diff });
	}

	private async inspectRepository(
		sessionId: string,
		task: CodingHarnessWorkflowInput,
		signal: AbortSignal,
	): Promise<GitRepositoryIdentity> {
		const policy = await this.authorize(
			sessionId,
			task,
			"understand",
			"git.repository.inspect",
			"git.repository.inspect",
			["read"],
			signal,
		);
		const request: GitCapabilityRequest = {
			policy,
			owner: this.owner(sessionId, task),
			repository: task.repository,
			operation: "repository.inspect",
		};
		return this.ports.git.inspectRepository(request);
	}

	private async understandRepository(
		sessionId: string,
		task: CodingHarnessWorkflowInput,
		repository: GitRepositoryIdentity,
		workflowRunId: string,
		signal: AbortSignal,
	): Promise<SessionJsonValue> {
		if (phaseCompleted(await this.readEvents(sessionId), "understand", workflowRunId))
			return this.phaseOutput(await this.readEvents(sessionId), "understand", workflowRunId);
		await this.phaseStarted(sessionId, workflowRunId, "understand", { repository });
		const scope: GraphScope = {
			repository: repository.repository,
			commit: repository.head.commit,
		};
		await this.authorize(sessionId, task, "understand", "graph.query", "graph.query", ["read"], signal);
		const graph = await this.ports.graph.search(
			{ scope, query: task.objective, pathPrefix: undefined, limit: 32 },
			{ signal },
		);
		const fallbackPaths =
			graph.status.primary === "fresh" && graph.freshness.state === "fresh" && graph.status.states.length === 1
				? []
				: [
						...new Set(
							task.sourcePaths ?? graph.items.flatMap((item) => (item.location?.path ? [item.location.path] : [])),
						),
					];
		const source = [] as Array<SessionJsonValue>;
		for (const path of fallbackPaths.slice(0, 32)) {
			await this.authorize(
				sessionId,
				task,
				"understand",
				"fs.workspace.read",
				"fs.workspace.read",
				["filesystem", "read"],
				signal,
			);
			const snapshot = await this.ports.source.read({
				scope,
				path,
				expected: { commit: repository.head.commit },
				signal,
			});
			source.push(asJson(snapshot));
		}
		const output = asJson({
			phase: "understand",
			objective: task.objective,
			graph: {
				provider: this.ports.graph.id,
				status: graph.status,
				freshness: graph.freshness,
				hits: graph.items.map((item) => ({ id: item.id, name: item.name, path: item.location?.path ?? null })),
			},
			source: source.map((item) => {
				const snapshot = objectPayload(item);
				return {
					path: snapshot?.path ?? null,
					contentHash: snapshot?.contentHash ?? null,
					content: snapshot?.content ?? null,
				};
			}),
		});
		await this.append(sessionId, [
			eventInput(sessionId, `${workflowRunId}:understand:completed`, "workflow.run.completed", {
				workflowRunId,
				phase: "understand",
				status: "completed",
				output,
				...(fallbackPaths.length
					? { graphFallback: { reason: graph.freshness.reason ?? graph.status.primary, paths: fallbackPaths } }
					: {}),
			}),
		]);
		return output;
	}

	private async modelPhase(
		sessionId: string,
		workflowRunId: string,
		phase: Extract<CodingHarnessPhase, "plan" | "implement" | "review">,
		objective: string,
		context: SessionJsonValue,
		events: readonly AgentSessionEvent[],
		signal: AbortSignal,
	): Promise<SessionJsonValue> {
		if (phaseCompleted(events, phase, workflowRunId)) return this.phaseOutput(events, phase, workflowRunId);
		await this.phaseStarted(sessionId, workflowRunId, phase, { objective });
		const kernel = this.kernelForPhase(phase);
		if (!kernel) {
			const output = asJson({
				phase,
				objective,
				contextAvailable: context !== null,
				planId: phase === "plan" ? `${workflowRunId}:plan` : undefined,
			});
			await this.phaseCompleted(sessionId, workflowRunId, phase, output);
			return output;
		}
		const accepted = await kernel.startTurn({ sessionId, content: asJson({ phase, objective, context }), signal });
		const result = await kernel.executeTurn({
			...accepted,
			content: asJson({ phase, objective, context }),
			signal,
		});
		if (result.status !== "completed") throw result.error ?? new Error(`${phase} model phase ${result.status}`);
		const output = result.content ?? null;
		await this.phaseCompleted(sessionId, workflowRunId, phase, output);
		return output;
	}

	private async approve(
		sessionId: string,
		workflowRunId: string,
		task: CodingHarnessWorkflowInput,
		plan: SessionJsonValue,
		events: readonly AgentSessionEvent[],
		signal: AbortSignal,
	): Promise<void> {
		if (phaseCompleted(events, "approve", workflowRunId)) return;
		const existing = [...events]
			.reverse()
			.find(
				(event) =>
					event.kind === "approval.requested" &&
					stringValue(objectPayload(event.payload)?.workflowRunId) === workflowRunId,
			);
		let interactionId = existing?.interactionId;
		let record = interactionId ? await this.interactions.get(interactionId) : undefined;
		if (!record) {
			const request = policyRequest({
				sessionId,
				task,
				phase: "approve",
				step: "approve",
				capability: "workflow.approval",
				effects: [],
				signal,
				approval: { version: "1", reason: "Review and approve the implementation plan", scope: task.objective },
			});
			const decision = {
				kind: "ask" as const,
				id: request.requestId,
				reasonCode: "human-approval",
				policyVersion: "desktop-v1",
			};
			record = await this.interactions.create(request, decision);
			interactionId = record.id;
			await this.append(sessionId, [
				eventInput(
					sessionId,
					`${workflowRunId}:approve:requested`,
					"approval.requested",
					{
						approvalId: record.id,
						interactionId: record.id,
						workflowRunId,
						phase: "approve",
						status: "awaiting-approval",
						plan,
					},
					{ workflowRunId, interactionId: record.id },
				),
			]);
		}
		while (record.status === "pending") {
			if (signal.aborted) throw new Error("approval cancelled");
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			record = (await this.interactions.get(interactionId as string)) ?? record;
		}
		if (record.status !== "answered") throw new Error(`approval ${record.status}`);
		await this.append(sessionId, [
			eventInput(
				sessionId,
				`${workflowRunId}:approve:resolved`,
				"approval.resolved",
				{
					approvalId: record.id,
					interactionId: record.id,
					phase: "approve",
					status: record.status,
					sequence: record.sequence,
				},
				{ workflowRunId, interactionId: record.id },
			),
			eventInput(
				sessionId,
				`${workflowRunId}:approve:completed`,
				"workflow.run.completed",
				{
					workflowRunId,
					phase: "approve",
					status: "completed",
					approved: true,
				},
				{ workflowRunId },
			),
		]);
	}

	private async implement(
		sessionId: string,
		workflowRunId: string,
		task: CodingHarnessWorkflowInput,
		repository: GitRepositoryIdentity,
		plan: SessionJsonValue,
		events: readonly AgentSessionEvent[],
		signal: AbortSignal,
	): Promise<GitWorktreeIdentity> {
		const completed = phaseCompleted(events, "implement", workflowRunId);
		const completedWorktree = objectPayload(completed?.payload ?? null)?.worktree;
		if (completedWorktree) return completedWorktree as unknown as GitWorktreeIdentity;
		const owner = this.owner(sessionId, task);
		const started = [...events]
			.reverse()
			.find(
				(event) =>
					event.kind === "workflow.run.started" &&
					stringValue(objectPayload(event.payload)?.workflowRunId) === workflowRunId &&
					phaseValue(objectPayload(event.payload)?.phase) === "implement" &&
					objectPayload(event.payload)?.worktree !== undefined,
			);
		let worktree: GitWorktreeIdentity;
		if (started) {
			worktree = objectPayload(started.payload)?.worktree as unknown as GitWorktreeIdentity;
		} else {
			const policy = await this.authorize(
				sessionId,
				task,
				"implement",
				"git.worktree.create",
				"git.worktree.create",
				["read", "write"],
				signal,
			);
			const base = task.base ?? task.repository.head;
			worktree = await this.ports.git.createWorktree({
				policy,
				owner,
				repository,
				base,
				branch: task.branch ?? `codex/${task.taskId}`,
				preserveSourceChanges: true,
			});
			await this.phaseStarted(sessionId, workflowRunId, "implement", { worktree });
		}
		const implementationPolicy = await this.authorize(
			sessionId,
			task,
			"implement",
			"workspace.write",
			"workspace.write",
			["filesystem", "write"],
			signal,
		);
		const result = await this.ports.implement({ task, worktree, plan, signal, owner, policy: implementationPolicy });
		for (const write of result.writes) {
			if (write.workspaceId !== worktree.path.workspaceId) throw new Error("implementation escaped the task worktree");
		}
		await this.phaseCompleted(
			sessionId,
			workflowRunId,
			"implement",
			asJson({ phase: "implement", worktree, writes: result.writes, artifact: result.artifact ?? null }),
		);
		return worktree;
	}

	private async test(
		sessionId: string,
		workflowRunId: string,
		task: CodingHarnessWorkflowInput,
		worktree: GitWorktreeIdentity,
		events: readonly AgentSessionEvent[],
		signal: AbortSignal,
	): Promise<CodingHarnessEvidence> {
		const completed = phaseCompleted(events, "test", workflowRunId);
		const existing = objectPayload(completed?.payload ?? null)?.evidence;
		if (existing) return existing as unknown as CodingHarnessEvidence;
		const spec = parseProcessSpec(this.ports.testSpec({ worktree, task }));
		if (spec.mode !== "executable") throw new Error("coding harness tests require structured executable process specs");
		if (spec.cwd.workspaceId !== worktree.path.workspaceId || spec.cwd.path !== worktree.path.path)
			throw new Error("test process cwd must be the task worktree");
		if (signal.aborted) throw new Error("test cancelled");
		const policy = await this.authorize(sessionId, task, "test", "process.exec", "process.exec", ["process"], signal);
		const started = await this.ports.process.start({ policy, spec, owner: this.owner(sessionId, task) });
		assertProcessStartResult(spec, started);
		if (started.kind !== "completed")
			throw new Error("foreground test process returned a durable handle without completion evidence");
		const result = parseProcessResult(started.result);
		if (signal.aborted) throw new Error("test cancelled");
		const evidence: CodingHarnessEvidence = {
			producer: "trusted-process",
			status:
				result.status === "exited" && result.exitCode === 0
					? "passed"
					: result.status === "cancelled"
						? "cancelled"
						: "failed",
			command: [spec.executable, ...spec.args],
			...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
			...(result.signal === undefined ? {} : { signal: result.signal }),
			stdout: result.output.stdout,
			stderr: result.output.stderr,
			durationMs: result.durationMs,
			capturedAt: this.now(),
		};
		await this.append(sessionId, [
			eventInput(
				sessionId,
				`${workflowRunId}:test:evidence`,
				"artifact.attached",
				asJson({ kind: "evidence", ...evidence }),
				{ workflowRunId },
			),
			eventInput(
				sessionId,
				`${workflowRunId}:test:completed`,
				"workflow.run.completed",
				asJson({ workflowRunId, phase: "test", status: "completed", evidence }),
				{ workflowRunId },
			),
		]);
		if (evidence.status !== "passed") throw new Error("trusted process test evidence failed");
		return evidence;
	}

	private async review(
		sessionId: string,
		workflowRunId: string,
		task: CodingHarnessWorkflowInput,
		repository: GitRepositoryIdentity,
		worktree: GitWorktreeIdentity,
		plan: SessionJsonValue,
		evidence: CodingHarnessEvidence,
		events: readonly AgentSessionEvent[],
		signal: AbortSignal,
	): Promise<SessionJsonValue> {
		const completed = phaseCompleted(events, "review", workflowRunId);
		if (completed) return objectPayload(completed.payload)?.diff ?? null;
		const policy = await this.authorize(
			sessionId,
			task,
			"review",
			"git.worktree.diff",
			"git.worktree.diff",
			["read"],
			signal,
		);
		const diff = await this.ports.git.diff({
			policy,
			owner: this.owner(sessionId, task),
			repository,
			worktree,
			operation: "worktree.diff",
		});
		await this.append(sessionId, [
			eventInput(sessionId, `${workflowRunId}:review:diff`, "artifact.attached", asJson({ kind: "diff", diff }), {
				workflowRunId,
			}),
		]);
		await this.phaseStarted(sessionId, workflowRunId, "review", { objective: task.objective });
		let output: SessionJsonValue = asJson({
			phase: "review",
			objective: task.objective,
			contextAvailable: true,
		});
		const kernel = this.kernelForPhase("review");
		if (kernel) {
			const content = asJson({ phase: "review", objective: task.objective, context: { plan, evidence, diff } });
			const accepted = await kernel.startTurn({ sessionId, content, signal });
			const result = await kernel.executeTurn({ ...accepted, content, signal });
			if (result.status !== "completed") throw result.error ?? new Error(`review model phase ${result.status}`);
			output = result.content ?? null;
		}
		await this.phaseCompleted(sessionId, workflowRunId, "review", asJson({ phase: "review", diff, output }));
		return asJson(diff);
	}

	private async authorize(
		sessionId: string,
		task: CodingHarnessWorkflowInput,
		phase: CodingHarnessPhase,
		capability: string,
		step: string,
		effects: readonly CapabilityEffect[],
		signal: AbortSignal,
	): Promise<PolicyRequest> {
		const request = policyRequest({ sessionId, task, phase, step, capability, effects, signal });
		const result = await this.ports.policy.evaluate(request);
		await this.append(sessionId, [
			eventInput(
				sessionId,
				`${request.requestId}:policy`,
				"policy.decision",
				asJson({ phase, capability, decision: result.decision, matchedRules: result.matchedRules }),
			),
		]);
		if (result.decision.kind !== "allow" && !(result.decision.kind === "require-sandbox" && result.sandbox?.proof))
			throw new Error(`policy ${result.decision.kind}: ${result.decision.reason ?? result.decision.reasonCode}`);
		return request;
	}

	private owner(sessionId: string, task: CodingHarnessWorkflowInput): GitCapabilityRequest["owner"] {
		return {
			principal: this.ports.principal ?? { id: task.taskId, kind: "desktop-task" },
			sessionId,
			taskId: task.taskId,
		};
	}

	private phaseOutput(
		events: readonly AgentSessionEvent[],
		phase: CodingHarnessPhase,
		workflowRunId?: string,
	): SessionJsonValue {
		const payload = objectPayload(phaseCompleted(events, phase, workflowRunId)?.payload ?? null);
		return payload?.output ?? payload ?? null;
	}

	private async phaseStarted(
		sessionId: string,
		workflowRunId: string,
		phase: CodingHarnessPhase,
		details: Record<string, unknown>,
	): Promise<void> {
		await this.append(sessionId, [
			eventInput(
				sessionId,
				`${workflowRunId}:${phase}:started`,
				"workflow.run.started",
				asJson({ workflowRunId, phase, status: phase === "approve" ? "awaiting-approval" : "running", ...details }),
				{ workflowRunId },
			),
		]);
	}

	private async phaseCompleted(
		sessionId: string,
		workflowRunId: string,
		phase: CodingHarnessPhase,
		output: SessionJsonValue,
	): Promise<void> {
		await this.append(sessionId, [
			eventInput(
				sessionId,
				`${workflowRunId}:${phase}:completed`,
				"workflow.run.completed",
				asJson({ workflowRunId, phase, status: "completed", output }),
				{ workflowRunId },
			),
		]);
	}

	private async readEvents(sessionId: string): Promise<readonly AgentSessionEvent[]> {
		const events: AgentSessionEvent[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.ports.sessionStore.read(sessionId, cursor ?? { afterSequence: 0, limit: 256 });
			events.push(...page.events);
			cursor = page.nextCursor;
		} while (cursor);
		return events;
	}

	private async append(sessionId: string, events: readonly SessionEventInput[]): Promise<void> {
		const prior = this.appendQueues.get(sessionId) ?? Promise.resolve();
		const next = prior.then(async () => {
			const state = await this.ports.sessionStore.fold(sessionId);
			await this.ports.sessionStore.append({ sessionId, expectedSequence: state.lastSequence, events });
		});
		this.appendQueues.set(
			sessionId,
			next.catch(() => undefined),
		);
		await next;
	}
}

export class DesktopCodingHarnessClient {
	constructor(private readonly client: CodingHarnessClientPort) {}

	async run(
		task: CodingHarnessTaskInput,
		options: {
			readonly signal?: AbortSignal;
			readonly onApproval?: (request: CodingHarnessApprovalRequest) => void | Promise<void>;
		} = {},
	): Promise<CodingHarnessRun> {
		const session = await this.client.createSession({
			principalId: task.taskId,
			metadata: { workflow: CODING_HARNESS_WORKFLOW_NAME },
		});
		const workflow = await this.client.startWorkflow(session.sessionId, {
			workflowName: CODING_HARNESS_WORKFLOW_NAME,
			input: asJson(task),
		});
		const events: ControlPlaneEvent[] = [];
		for await (const event of this.client.streamEvents(
			{ sessionId: session.sessionId, afterSequence: 0, follow: true },
			options,
		)) {
			events.push(event);
			const interactionId = eventInteractionId(event);
			if (event.kind === "approval.requested" && interactionId) {
				const payload = objectPayload(event.payload);
				await options.onApproval?.({
					sessionId: session.sessionId,
					interactionId,
					sequence: typeof payload?.sequence === "number" ? payload.sequence : 0,
					...(payload?.plan === undefined ? {} : { plan: payload.plan }),
				});
			}
			if (event.kind === "workflow.run.completed" && objectPayload(event.payload)?.phase === "complete") break;
			if (
				event.kind === "workflow.run.failed" &&
				objectPayload(event.payload)?.workflowRunId === workflow.workflowRunId
			)
				break;
		}
		return {
			sessionId: session.sessionId,
			workflowRunId: workflow.workflowRunId,
			events,
			state: stateFromEvents(session.sessionId, task, events),
		};
	}

	async approve(
		sessionId: string,
		interactionId: string,
		sequence: number,
		answer: SessionJsonValue = { approved: true },
	): Promise<void> {
		await this.client.answerInteraction(sessionId, { interactionId, sequence, answer });
		const resolved = await this.client.inspectSession({ sessionId });
		const current = (resolved.state as { pendingApprovals?: readonly string[] } | undefined)?.pendingApprovals ?? [];
		if (current.includes(interactionId)) await this.client.resume(sessionId, { interactionId, sequence: sequence + 1 });
	}

	cancel(
		sessionId: string,
		target: "session" | "turn" | "workflow",
		targetId?: string,
		reason = "user cancelled",
	): Promise<unknown> {
		return this.client.cancel(sessionId, { target, targetId, reason });
	}
}

export function stateFromEvents(
	sessionId: string,
	task: CodingHarnessTaskInput,
	events: readonly AgentSessionEvent[] | readonly ControlPlaneEvent[],
): CodingHarnessState {
	const normalized = events as readonly AgentSessionEvent[];
	let current: CodingHarnessPhase | "complete" | "failed" | "cancelled" = "understand";
	let phaseStatus: CodingHarnessState["phaseStatus"] = "pending";
	let worktree: GitWorktreeIdentity | undefined;
	let approval: CodingHarnessState["approval"];
	let graphFallback: CodingHarnessState["graphFallback"];
	let evidence: CodingHarnessEvidence | undefined;
	let diff: unknown;
	let terminal: CodingHarnessState["terminal"];
	let activeTurnId: string | undefined;
	const decisions: CodingHarnessPolicyDecision[] = [];
	for (const event of normalized) {
		const payload = objectPayload(event.payload);
		if (event.kind === "turn.started") {
			const turnId = event.turnId ?? stringValue(payload?.turnId);
			if (turnId) activeTurnId = turnId;
		}
		if (event.kind === "turn.completed" && (event.turnId ?? activeTurnId) === activeTurnId) activeTurnId = undefined;
		if (event.kind === "policy.decision" && payload?.decision && payload.capability && payload.phase) {
			decisions.push({
				phase: payload.phase as CodingHarnessPhase,
				capability: String(payload.capability),
				decision: payload.decision as unknown as CodingHarnessPolicyDecision["decision"],
				matchedRules: (payload.matchedRules ?? []) as unknown as CodingHarnessPolicyDecision["matchedRules"],
			});
		}
		const phase = phaseValue(payload?.phase);
		if (phase && payload) {
			current = phase;
			phaseStatus =
				payload?.status === "completed"
					? "completed"
					: payload?.status === "awaiting-approval"
						? "awaiting-approval"
						: "running";
			if (payload.worktree) worktree = payload.worktree as unknown as GitWorktreeIdentity;
			if (payload.graphFallback)
				graphFallback = payload.graphFallback as unknown as CodingHarnessState["graphFallback"];
		}
		const interactionId = eventInteractionId(event, payload);
		if (event.kind === "approval.requested" && interactionId)
			approval = { interactionId, status: "pending", sequence: 0 };
		if (event.kind === "approval.resolved" && interactionId && approval?.interactionId === interactionId) {
			const status = stringValue(payload?.status);
			if (status && (["pending", "answered", "denied", "expired", "cancelled"] as readonly string[]).includes(status))
				approval = {
					interactionId,
					status: status as InteractionStatus,
					sequence: typeof payload?.sequence === "number" ? payload.sequence : approval.sequence,
				};
		}
		if (event.kind === "artifact.attached" && payload?.kind === "evidence")
			evidence = payload as unknown as CodingHarnessEvidence;
		if (event.kind === "artifact.attached" && payload?.kind === "diff") diff = payload.diff;
		if (event.kind === "workflow.run.completed" && payload?.phase === "complete") {
			current = "complete";
			phaseStatus = "completed";
			terminal = { status: "completed" };
		}
		if (event.kind === "workflow.run.failed" && (payload?.status === "cancelled" || payload?.status === "failed")) {
			current = payload.status as "cancelled" | "failed";
			phaseStatus = current;
			terminal = { status: current, message: stringValue(payload.message) };
		}
	}
	return {
		sessionId,
		taskId: task.taskId,
		objective: task.objective,
		phase: current,
		phaseStatus,
		workflowRunId: latestRunId(normalized),
		activeTurnId,
		worktree,
		approval,
		graphFallback,
		decisions,
		evidence,
		diff,
		stream: normalized,
		terminal,
	};
}

export async function startCodingHarnessServer(options: CodingHarnessServerOptions): Promise<CodingHarnessServer> {
	const interactionStore = options.interactionStore ?? new InMemoryInteractionStore();
	const runtime = new CodingHarnessRuntime({ ...options, interactionStore });
	const server = await HarnessControlPlaneServer.start({
		sessionStore: options.sessionStore,
		interactionStore,
		listenAddress: options.listenAddress,
		token: options.token,
		closeStoreOnStop: options.closeStoreOnStop,
		executeTurn: (input) => runtime.executeTurn(input),
		executeWorkflow: (input) => runtime.executeWorkflow(input),
	});
	return { server, runtime };
}
