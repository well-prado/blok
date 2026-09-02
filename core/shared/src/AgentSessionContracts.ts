import { z } from "zod";

export const AGENT_SESSION_CONTRACT_VERSION = "1" as const;
export const AGENT_SESSION_SCHEMA_VERSION = 1 as const;
export const AGENT_SESSION_MAX_EVENT_BYTES = 64 * 1024;
export const AGENT_SESSION_MAX_PAYLOAD_DEPTH = 8;
export const AGENT_SESSION_MAX_PAYLOAD_ITEMS = 256;
export const AGENT_SESSION_MAX_STRING_LENGTH = 8 * 1024;
export const AGENT_SESSION_MAX_EVENTS_PER_APPEND = 128;
export const AGENT_SESSION_MAX_PAGE_SIZE = 256;
export const AGENT_SESSION_MAX_SNAPSHOT_BYTES = 256 * 1024;

export type AgentSessionEventVisibility = "model-visible" | "operational";
export type AgentSessionActorKind = "user" | "agent" | "system" | "tool" | "workflow";

export const AGENT_SESSION_EVENT_KINDS = [
	"session.created",
	"session.closed",
	"session.forked",
	"turn.started",
	"turn.completed",
	"message.user",
	"message.assistant",
	"message.tool",
	"model.stream",
	"model.completed",
	"tool.call.started",
	"tool.call.completed",
	"tool.call.failed",
	"workflow.run.started",
	"workflow.run.completed",
	"workflow.run.failed",
	"steering.received",
	"approval.requested",
	"approval.resolved",
	"policy.decision",
	"compaction.started",
	"compaction.completed",
	"budget.updated",
	"budget.exhausted",
	"background.work.started",
	"background.work.completed",
	"background.work.failed",
	"artifact.attached",
] as const;

export type AgentSessionEventKind = (typeof AGENT_SESSION_EVENT_KINDS)[number];

export type SessionJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly SessionJsonValue[]
	| Readonly<{ [key: string]: SessionJsonValue }>;

export interface SessionActor {
	readonly kind: AgentSessionActorKind;
	readonly id?: string;
}

export interface ArtifactReference {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
	readonly sizeBytes: number;
	readonly mediaType?: string;
	readonly uri?: string;
}

export interface AgentSessionEvent {
	readonly contractVersion: typeof AGENT_SESSION_CONTRACT_VERSION;
	readonly schemaVersion: typeof AGENT_SESSION_SCHEMA_VERSION;
	readonly id: string;
	readonly sessionId: string;
	readonly turnId?: string;
	readonly kind: AgentSessionEventKind;
	readonly visibility: AgentSessionEventVisibility;
	readonly actor: SessionActor;
	readonly causationId?: string;
	readonly correlationId?: string;
	/** Optional durable links to the workflow and interaction that caused a fact. */
	readonly workflowRunId?: string;
	readonly interactionId?: string;
	readonly idempotencyKey?: string;
	readonly sequence: number;
	readonly occurredAt: string;
	readonly payload: SessionJsonValue;
}

export type SessionEvent = AgentSessionEvent;
export type SessionEventInput = Omit<AgentSessionEvent, "sequence"> & { readonly sequence?: never };

export interface SessionCursor {
	readonly afterSequence?: number;
	readonly limit?: number;
}

export interface SessionEventPage {
	readonly sessionId: string;
	readonly events: readonly AgentSessionEvent[];
	readonly nextCursor?: string;
	readonly lastSequence: number;
	readonly corruptTail?: CorruptSessionTail;
}

export interface CorruptSessionTail {
	readonly sequence: number;
	readonly reason: string;
}

export interface SessionSnapshot {
	readonly contractVersion: typeof AGENT_SESSION_CONTRACT_VERSION;
	readonly schemaVersion: typeof AGENT_SESSION_SCHEMA_VERSION;
	readonly sessionId: string;
	readonly sequence: number;
	readonly state: SessionState;
	readonly createdAt: string;
}

export interface SessionFork {
	readonly sessionId: string;
	readonly parentSessionId: string;
	readonly parentSequence: number;
	readonly createdAt: string;
}

export interface SessionMessage {
	readonly id: string;
	readonly turnId?: string;
	readonly role: "user" | "assistant" | "tool";
	readonly content: SessionJsonValue;
	readonly sequence: number;
}

export interface SessionState {
	readonly sessionId: string;
	readonly lastSequence: number;
	readonly messages: readonly SessionMessage[];
	readonly activeTurnId?: string;
	readonly pendingApprovals: readonly string[];
	readonly workflowRuns: Readonly<Record<string, string>>;
	readonly backgroundWork: Readonly<Record<string, string>>;
	readonly budgets: Readonly<Record<string, number>>;
	readonly artifacts: readonly ArtifactReference[];
	readonly lineage?: SessionFork;
	readonly closed: boolean;
}

export interface SessionFoldOptions {
	readonly initialState?: SessionState;
}

export interface AppendSessionEventsInput {
	readonly sessionId: string;
	readonly expectedSequence: number;
	readonly events: readonly SessionEventInput[];
}

export interface AppendSessionEventsResult {
	readonly sessionId: string;
	readonly events: readonly AgentSessionEvent[];
	readonly sequence: number;
	readonly idempotent: boolean;
}

export interface SessionRetentionOptions {
	readonly beforeSequence: number;
	readonly snapshotSequence: number;
}

export interface SessionStore {
	append(input: AppendSessionEventsInput): Promise<AppendSessionEventsResult>;
	read(sessionId: string, cursor?: SessionCursor | string): Promise<SessionEventPage>;
	getSnapshot(sessionId: string): Promise<SessionSnapshot | undefined>;
	saveSnapshot(snapshot: SessionSnapshot): Promise<void>;
	fold(sessionId: string, options?: SessionFoldOptions): Promise<SessionState>;
	fork(parentSessionId: string, parentSequence: number, childSessionId: string): Promise<SessionFork>;
	retain(sessionId: string, options: SessionRetentionOptions): Promise<number>;
	migrate(): Promise<void>;
	close?(): void | Promise<void>;
}

export class AgentSessionContractError extends Error {
	readonly code = "AGENT_SESSION_INVALID";

	constructor(message: string) {
		super(message);
		this.name = "AgentSessionContractError";
	}
}

export class SessionConcurrencyError extends Error {
	readonly code = "AGENT_SESSION_CONCURRENCY_CONFLICT";

	constructor(message: string) {
		super(message);
		this.name = "SessionConcurrencyError";
	}
}

export class SessionCorruptTailError extends Error {
	readonly code = "AGENT_SESSION_CORRUPT_TAIL";
	readonly tail: CorruptSessionTail;

	constructor(tail: CorruptSessionTail) {
		super(`session event ${tail.sequence} is corrupt: ${tail.reason}`);
		this.name = "SessionCorruptTailError";
		this.tail = tail;
	}
}

export const SessionJsonValueSchema: z.ZodType<SessionJsonValue> = z.lazy(() =>
	z.union([
		z.string().max(AGENT_SESSION_MAX_STRING_LENGTH),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(SessionJsonValueSchema).max(AGENT_SESSION_MAX_PAYLOAD_ITEMS),
		z.record(SessionJsonValueSchema).refine((value) => Object.keys(value).length <= AGENT_SESSION_MAX_PAYLOAD_ITEMS),
	]),
);

const actorSchema = z
	.object({ kind: z.enum(["user", "agent", "system", "tool", "workflow"]), id: z.string().min(1).max(256).optional() })
	.strict();

export const SessionActorSchema = actorSchema;

export const ArtifactReferenceSchema = z
	.object({
		id: z.string().min(1).max(256),
		version: z.string().min(1).max(256),
		digest: z.string().regex(/^[a-z0-9]+:[a-f0-9]{16,}$/),
		sizeBytes: z.number().int().nonnegative().safe(),
		mediaType: z.string().min(1).max(256).optional(),
		uri: z.string().min(1).max(2048).optional(),
	})
	.strict();

const sessionEventShape = {
	contractVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION),
	schemaVersion: z.literal(AGENT_SESSION_SCHEMA_VERSION),
	id: z.string().min(1).max(256),
	sessionId: z.string().min(1).max(256),
	turnId: z.string().min(1).max(256).optional(),
	kind: z.enum(AGENT_SESSION_EVENT_KINDS),
	visibility: z.enum(["model-visible", "operational"]),
	actor: actorSchema,
	causationId: z.string().min(1).max(256).optional(),
	correlationId: z.string().min(1).max(256).optional(),
	workflowRunId: z.string().min(1).max(256).optional(),
	interactionId: z.string().min(1).max(256).optional(),
	idempotencyKey: z.string().min(1).max(256).optional(),
	occurredAt: z.string(),
	payload: SessionJsonValueSchema,
};

export const SessionEventSchema = z
	.object({ ...sessionEventShape, sequence: z.number().int().positive().safe() })
	.strict();
export const SessionEventInputSchema = z.object(sessionEventShape).strict();

const hiddenReasoningKey =
	/^(?:reasoning|hidden[_-]?reasoning|chain[_-]?of[_-]?thought|cot|thoughts?|internal[_-]?reasoning)$/i;

function assertNoHiddenReasoning(value: unknown, path = "payload"): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => assertNoHiddenReasoning(item, `${path}[${index}]`));
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (hiddenReasoningKey.test(key))
			throw new AgentSessionContractError(`${path}.${key} is not durable session state`);
		assertNoHiddenReasoning(child, `${path}.${key}`);
	}
}

function assertPayloadDepth(value: unknown, depth = 0, path = "payload"): void {
	if (depth > AGENT_SESSION_MAX_PAYLOAD_DEPTH)
		throw new AgentSessionContractError(`${path} exceeds maximum depth of ${AGENT_SESSION_MAX_PAYLOAD_DEPTH}`);
	if (Array.isArray(value)) {
		value.forEach((item, index) => assertPayloadDepth(item, depth + 1, `${path}[${index}]`));
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) assertPayloadDepth(child, depth + 1, `${path}.${key}`);
	}
}

function assertDate(value: string, path: string): string {
	if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
		throw new AgentSessionContractError(`${path} must be a canonical ISO timestamp`);
	return value;
}

function eventBytes(event: AgentSessionEvent | SessionEventInput): number {
	return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

export function parseArtifactReference(value: unknown): ArtifactReference {
	const result = ArtifactReferenceSchema.safeParse(value);
	if (!result.success) throw new AgentSessionContractError("invalid artifact reference");
	return immutableSessionSnapshot(result.data);
}

export function parseSessionEvent(value: unknown): AgentSessionEvent {
	const result = SessionEventSchema.safeParse(value);
	if (!result.success) throw new AgentSessionContractError("invalid session event envelope");
	assertDate(result.data.occurredAt, "event.occurredAt");
	assertPayloadDepth(result.data.payload);
	assertNoHiddenReasoning(result.data.payload);
	if (eventBytes(result.data) > AGENT_SESSION_MAX_EVENT_BYTES)
		throw new AgentSessionContractError(
			`event exceeds ${AGENT_SESSION_MAX_EVENT_BYTES} bytes; use an artifact reference`,
		);
	return immutableSessionSnapshot(result.data);
}

export function parseSessionEventInput(value: unknown): SessionEventInput {
	const result = SessionEventInputSchema.safeParse(value);
	if (!result.success) throw new AgentSessionContractError("invalid session event input");
	assertDate(result.data.occurredAt, "event.occurredAt");
	assertPayloadDepth(result.data.payload);
	assertNoHiddenReasoning(result.data.payload);
	if (eventBytes(result.data) > AGENT_SESSION_MAX_EVENT_BYTES)
		throw new AgentSessionContractError(
			`event exceeds ${AGENT_SESSION_MAX_EVENT_BYTES} bytes; use an artifact reference`,
		);
	return immutableSessionSnapshot(result.data);
}

export function serializeSessionEvent(event: AgentSessionEvent): string {
	return JSON.stringify(parseSessionEvent(event));
}

export function parseSessionCursor(value: SessionCursor | string | undefined): Required<SessionCursor> {
	if (value === undefined) return { afterSequence: 0, limit: AGENT_SESSION_MAX_PAGE_SIZE };
	if (typeof value === "string") {
		const match = /^s(\d+)$/.exec(value);
		if (!match) throw new AgentSessionContractError("invalid session cursor");
		return { afterSequence: Number(match[1]), limit: AGENT_SESSION_MAX_PAGE_SIZE };
	}
	const afterSequence = value.afterSequence ?? 0;
	const limit = value.limit ?? AGENT_SESSION_MAX_PAGE_SIZE;
	if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
		throw new AgentSessionContractError("invalid cursor sequence");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_SESSION_MAX_PAGE_SIZE)
		throw new AgentSessionContractError(`cursor limit must be from 1 to ${AGENT_SESSION_MAX_PAGE_SIZE}`);
	return { afterSequence, limit };
}

export function cursorForSequence(sequence: number): string {
	if (!Number.isSafeInteger(sequence) || sequence < 0) throw new AgentSessionContractError("invalid cursor sequence");
	return `s${sequence}`;
}

export function immutableSessionSnapshot<T>(value: T): T {
	const snapshot = structuredClone(value);
	const freeze = (item: unknown): void => {
		if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
		for (const child of Object.values(item)) freeze(child);
		Object.freeze(item);
	};
	freeze(snapshot);
	return snapshot;
}

export function fingerprintSessionEvent(event: AgentSessionEvent | SessionEventInput): string {
	const { sequence: _sequence, ...withoutSequence } = event as AgentSessionEvent;
	return stableJson(withoutSequence);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

export function foldSessionEvents(
	events: readonly AgentSessionEvent[],
	options: SessionFoldOptions = {},
): SessionState {
	const first = options.initialState ?? {
		sessionId: events[0]?.sessionId ?? "",
		lastSequence: 0,
		messages: [],
		pendingApprovals: [],
		workflowRuns: {},
		backgroundWork: {},
		budgets: {},
		artifacts: [],
		closed: false,
	};
	const messages = [...first.messages];
	const pendingApprovals = new Set(first.pendingApprovals);
	const workflowRuns = { ...first.workflowRuns };
	const backgroundWork = { ...first.backgroundWork };
	const budgets = { ...first.budgets };
	const artifacts = [...first.artifacts];
	let activeTurnId = first.activeTurnId;
	let lineage = first.lineage;
	let closed = first.closed;
	const objectPayload = (payload: SessionJsonValue): Readonly<{ [key: string]: SessionJsonValue }> | undefined => {
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
		return payload as Readonly<{ [key: string]: SessionJsonValue }>;
	};
	for (const event of events) {
		if (event.sessionId !== first.sessionId)
			throw new AgentSessionContractError("cannot fold events from different sessions");
		switch (event.kind) {
			case "turn.started":
				activeTurnId = event.turnId;
				break;
			case "turn.completed":
				if (activeTurnId === event.turnId) activeTurnId = undefined;
				break;
			case "message.user":
			case "message.assistant":
			case "message.tool":
				if (event.visibility === "model-visible")
					messages.push({
						id: event.id,
						turnId: event.turnId,
						role: event.kind.split(".")[1] as SessionMessage["role"],
						content: event.payload,
						sequence: event.sequence,
					});
				break;
			case "approval.requested":
				pendingApprovals.add(event.id);
				break;
			case "approval.resolved":
				{
					const approvalId = objectPayload(event.payload)?.approvalId;
					pendingApprovals.delete(typeof approvalId === "string" ? approvalId : event.id);
				}
				break;
			case "workflow.run.started":
			case "workflow.run.completed":
			case "workflow.run.failed":
				workflowRuns[event.id] = event.kind.split(".").at(-1) ?? "unknown";
				break;
			case "background.work.started":
			case "background.work.completed":
			case "background.work.failed":
				backgroundWork[event.id] = event.kind.split(".").at(-1) ?? "unknown";
				break;
			case "budget.updated":
			case "budget.exhausted":
				{
					const payload = objectPayload(event.payload);
					const name = typeof payload?.name === "string" ? payload.name : "default";
					const value = payload?.remaining;
					if (typeof value === "number") budgets[name] = value;
				}
				break;
			case "artifact.attached":
				if (ArtifactReferenceSchema.safeParse(event.payload).success)
					artifacts.push(parseArtifactReference(event.payload));
				break;
			case "session.forked":
				{
					const payload = objectPayload(event.payload);
					const parentSessionId = payload?.parentSessionId;
					const parentSequence = payload?.parentSequence;
					if (typeof parentSessionId === "string" && typeof parentSequence === "number")
						lineage = { sessionId: first.sessionId, parentSessionId, parentSequence, createdAt: event.occurredAt };
				}
				break;
			case "session.closed":
				closed = true;
				break;
		}
	}
	return immutableSessionSnapshot({
		...first,
		lastSequence: events.at(-1)?.sequence ?? first.lastSequence,
		messages,
		...(activeTurnId === undefined ? {} : { activeTurnId }),
		pendingApprovals: [...pendingApprovals].sort(),
		workflowRuns,
		backgroundWork,
		budgets,
		artifacts,
		...(lineage ? { lineage } : {}),
		closed,
	});
}
