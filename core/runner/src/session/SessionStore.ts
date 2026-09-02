import { randomUUID } from "node:crypto";
import {
	AGENT_SESSION_CONTRACT_VERSION,
	AGENT_SESSION_MAX_EVENTS_PER_APPEND,
	AGENT_SESSION_MAX_SNAPSHOT_BYTES,
	AgentSessionContractError,
	type AgentSessionEvent,
	type AppendSessionEventsInput,
	type AppendSessionEventsResult,
	type CorruptSessionTail,
	SessionConcurrencyError,
	type SessionCursor,
	type SessionEventInput,
	type SessionEventPage,
	type SessionFork,
	type SessionJsonValue,
	type SessionRetentionOptions,
	type SessionSnapshot,
	type SessionState,
	type SessionStore,
	cursorForSequence,
	fingerprintSessionEvent,
	foldSessionEvents,
	immutableSessionSnapshot,
	parseSessionCursor,
	parseSessionEvent,
	parseSessionEventInput,
} from "@blokjs/shared";

export { SessionCorruptTailError } from "@blokjs/shared";

export interface SessionStoreRecord {
	readonly sessionId: string;
	readonly events: readonly AgentSessionEvent[];
	readonly lastSequence: number;
	readonly snapshots: ReadonlyMap<number, SessionSnapshot>;
}

export function validateAppend(input: AppendSessionEventsInput): readonly SessionEventInput[] {
	if (typeof input.sessionId !== "string" || input.sessionId.length === 0 || input.sessionId.length > 256)
		throw new AgentSessionContractError("session id is invalid");
	if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0)
		throw new AgentSessionContractError("expected sequence must be a non-negative safe integer");
	if (input.events.length < 1 || input.events.length > AGENT_SESSION_MAX_EVENTS_PER_APPEND)
		throw new AgentSessionContractError(`append must contain 1 to ${AGENT_SESSION_MAX_EVENTS_PER_APPEND} events`);
	const events = input.events.map((event) => parseSessionEventInput(event));
	const eventIds = new Set<string>();
	const idempotencyKeys = new Set<string>();
	for (const event of events) {
		if (event.sessionId !== input.sessionId)
			throw new AgentSessionContractError("event session does not match append session");
		if (eventIds.has(event.id)) throw new AgentSessionContractError("append contains duplicate event ids");
		eventIds.add(event.id);
		if (event.idempotencyKey !== undefined) {
			if (idempotencyKeys.has(event.idempotencyKey))
				throw new AgentSessionContractError("append contains duplicate idempotency keys");
			idempotencyKeys.add(event.idempotencyKey);
		}
	}
	return immutableSessionSnapshot(events);
}

export function eventFromInput(event: SessionEventInput, sequence: number): AgentSessionEvent {
	return parseSessionEvent({ ...event, sequence });
}

export function readPage(
	sessionId: string,
	events: readonly AgentSessionEvent[],
	lastSequence: number,
	cursor: Parameters<typeof parseSessionCursor>[0],
	corruptTail?: CorruptSessionTail,
): SessionEventPage {
	const { afterSequence, limit } = parseSessionCursor(cursor);
	const available = events.filter((event) => event.sequence > afterSequence);
	const pageEvents = available.slice(0, limit);
	const last = pageEvents.at(-1)?.sequence;
	return immutableSessionSnapshot({
		sessionId,
		events: pageEvents,
		lastSequence,
		...(available.length > limit && last !== undefined ? { nextCursor: cursorForSequence(last) } : {}),
		...(corruptTail ? { corruptTail } : {}),
	});
}

export function validateSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
	if (snapshot.contractVersion !== AGENT_SESSION_CONTRACT_VERSION || snapshot.schemaVersion !== 1)
		throw new AgentSessionContractError("unsupported session snapshot version");
	if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0)
		throw new AgentSessionContractError("snapshot sequence is invalid");
	if (snapshot.state.sessionId !== snapshot.sessionId || snapshot.state.lastSequence > snapshot.sequence)
		throw new AgentSessionContractError("snapshot state does not match its session or sequence");
	const serialized = JSON.stringify(snapshot);
	if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > AGENT_SESSION_MAX_SNAPSHOT_BYTES)
		throw new AgentSessionContractError("snapshot exceeds the maximum size");
	return immutableSessionSnapshot(snapshot);
}

export function parseForkPayload(payload: unknown): { parentSessionId: string; parentSequence: number } {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload))
		throw new AgentSessionContractError("fork payload is invalid");
	const value = payload as Record<string, unknown>;
	if (
		typeof value.parentSessionId !== "string" ||
		typeof value.parentSequence !== "number" ||
		!Number.isSafeInteger(value.parentSequence)
	)
		throw new AgentSessionContractError("fork payload is invalid");
	return { parentSessionId: value.parentSessionId, parentSequence: value.parentSequence };
}

export function makeForkEvent(
	parentSessionId: string,
	parentSequence: number,
	childSessionId: string,
): SessionEventInput {
	return {
		contractVersion: "1",
		schemaVersion: 1,
		id: randomUUID(),
		sessionId: childSessionId,
		kind: "session.forked",
		visibility: "operational",
		actor: { kind: "system", id: "session-store" },
		occurredAt: new Date().toISOString(),
		payload: { parentSessionId, parentSequence },
	};
}

export function checkDuplicate(
	existing: readonly AgentSessionEvent[],
	input: readonly SessionEventInput[],
): { events: readonly AgentSessionEvent[]; idempotent: boolean } | undefined {
	const byId = new Map(existing.map((event) => [event.id, event]));
	const byKey = new Map(
		existing.filter((event) => event.idempotencyKey).map((event) => [event.idempotencyKey as string, event]),
	);
	const duplicates = input.map((event) => byKey.get(event.idempotencyKey ?? "") ?? byId.get(event.id));
	if (duplicates.every((event) => event !== undefined)) {
		const matching = duplicates as AgentSessionEvent[];
		if (matching.every((event, index) => fingerprintSessionEvent(event) === fingerprintSessionEvent(input[index])))
			return { events: matching, idempotent: true };
		throw new SessionConcurrencyError("idempotency key or event id was reused with different data");
	}
	if (duplicates.some((event) => event !== undefined))
		throw new SessionConcurrencyError("append partially duplicates existing events");
	return undefined;
}

export function isUniqueConstraintError(error: unknown): boolean {
	if (error === null || typeof error !== "object") return false;
	const value = error as Record<string, unknown>;
	return value.code === "23505" || (typeof value.code === "string" && value.code.startsWith("SQLITE_CONSTRAINT"));
}

export abstract class BaseSessionStore implements SessionStore {
	abstract append(input: AppendSessionEventsInput): Promise<AppendSessionEventsResult>;
	abstract read(sessionId: string, cursor?: SessionCursor | string): Promise<SessionEventPage>;
	abstract getSnapshot(sessionId: string): Promise<SessionSnapshot | undefined>;
	abstract saveSnapshot(snapshot: SessionSnapshot): Promise<void>;
	abstract fork(parentSessionId: string, parentSequence: number, childSessionId: string): Promise<SessionFork>;
	abstract retain(sessionId: string, options: SessionRetentionOptions): Promise<number>;
	abstract migrate(): Promise<void>;

	async fold(sessionId: string, options: { initialState?: SessionState } = {}): Promise<SessionState> {
		return this.foldThrough(sessionId, Number.MAX_SAFE_INTEGER, options);
	}

	private async foldThrough(
		sessionId: string,
		throughSequence: number,
		options: { initialState?: SessionState } = {},
	): Promise<SessionState> {
		const snapshot = await this.getSnapshot(sessionId);
		const initialState =
			options.initialState ?? (snapshot && snapshot.sequence <= throughSequence ? snapshot.state : undefined);
		const afterSequence = initialState ? (options.initialState ? 0 : snapshot?.sequence) : 0;
		const page = await this.read(sessionId, { afterSequence, limit: 256 });
		const loadedEvents = page.nextCursor ? [...page.events, ...(await this.readAll(sessionId, page))] : page.events;
		if (!initialState && throughSequence > 0 && loadedEvents[0] && loadedEvents[0].sequence > 1)
			throw new AgentSessionContractError("cannot fold a historical session after its prefix was retained");
		const events = loadedEvents.filter((event) => event.sequence <= throughSequence);
		let inherited = initialState;
		if (!inherited) {
			const fork = events.find((event) => event.kind === "session.forked");
			if (fork) {
				const payload = fork.payload;
				if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
					const parentSessionId = (payload as Readonly<Record<string, SessionJsonValue>>).parentSessionId;
					const parentSequence = (payload as Readonly<Record<string, SessionJsonValue>>).parentSequence;
					if (typeof parentSessionId === "string" && typeof parentSequence === "number") {
						const parent = await this.foldThrough(parentSessionId, parentSequence);
						inherited = { ...parent, sessionId, lastSequence: 0, lineage: undefined };
					}
				}
			}
		}
		if (!inherited && events.length === 0) inherited = emptySessionState(sessionId);
		return foldSessionEvents(events, { initialState: inherited });
	}

	private async readAll(sessionId: string, page: SessionEventPage): Promise<readonly AgentSessionEvent[]> {
		const result = [...page.events];
		let cursor = page.nextCursor;
		while (cursor) {
			const next = await this.read(sessionId, cursor);
			result.push(...next.events);
			cursor = next.nextCursor;
		}
		return result;
	}
}

function emptySessionState(sessionId: string): SessionState {
	return {
		sessionId,
		lastSequence: 0,
		messages: [],
		pendingApprovals: [],
		workflowRuns: {},
		backgroundWork: {},
		budgets: {},
		artifacts: [],
		closed: false,
	};
}
