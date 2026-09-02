import type {
	AgentSessionEvent,
	AppendSessionEventsInput,
	AppendSessionEventsResult,
	SessionCursor,
	SessionEventPage,
	SessionFork,
	SessionRetentionOptions,
	SessionSnapshot,
	SessionStore,
} from "@blokjs/shared";
import { AgentSessionContractError, SessionConcurrencyError, immutableSessionSnapshot } from "@blokjs/shared";
import {
	BaseSessionStore,
	checkDuplicate,
	eventFromInput,
	makeForkEvent,
	readPage,
	validateAppend,
	validateSnapshot,
} from "./SessionStore";

interface SessionData {
	events: AgentSessionEvent[];
	lastSequence: number;
	snapshot?: SessionSnapshot;
}

/** Reference implementation used by contract tests and embedders without a database. */
export class MemorySessionStore extends BaseSessionStore implements SessionStore {
	private readonly sessions = new Map<string, SessionData>();

	private data(sessionId: string): SessionData {
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
		const created: SessionData = { events: [], lastSequence: 0 };
		this.sessions.set(sessionId, created);
		return created;
	}

	async append(input: AppendSessionEventsInput): Promise<AppendSessionEventsResult> {
		const events = validateAppend(input);
		const data = this.data(input.sessionId);
		const duplicate = checkDuplicate(data.events, events);
		if (duplicate)
			return immutableSessionSnapshot({
				sessionId: input.sessionId,
				events: duplicate.events,
				sequence: data.lastSequence,
				idempotent: true,
			});
		if (data.lastSequence !== input.expectedSequence)
			throw new SessionConcurrencyError(
				`expected sequence ${input.expectedSequence}, actual sequence ${data.lastSequence}`,
			);
		const appended = events.map((event, index) => eventFromInput(event, data.lastSequence + index + 1));
		data.events.push(...appended);
		data.lastSequence += appended.length;
		return immutableSessionSnapshot({
			sessionId: input.sessionId,
			events: appended,
			sequence: data.lastSequence,
			idempotent: false,
		});
	}

	async read(sessionId: string, cursor?: SessionCursor | string): Promise<SessionEventPage> {
		const data = this.data(sessionId);
		return readPage(sessionId, data.events, data.lastSequence, cursor);
	}

	async getSnapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
		return this.data(sessionId).snapshot;
	}

	async saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
		const safe = validateSnapshot(snapshot);
		const data = this.data(snapshot.sessionId);
		if (safe.sequence > data.lastSequence)
			throw new AgentSessionContractError("snapshot is ahead of the session event log");
		if (data.snapshot && safe.sequence < data.snapshot.sequence)
			throw new SessionConcurrencyError("snapshot sequence moved backwards");
		data.snapshot = safe;
	}

	async fork(parentSessionId: string, parentSequence: number, childSessionId: string): Promise<SessionFork> {
		if (this.sessions.has(childSessionId)) throw new SessionConcurrencyError("child session already exists");
		const parent = this.data(parentSessionId);
		if (!Number.isSafeInteger(parentSequence) || parentSequence < 0 || parentSequence > parent.lastSequence)
			throw new AgentSessionContractError("parent sequence is outside the parent log");
		const child: SessionData = { events: [], lastSequence: 0 };
		this.sessions.set(childSessionId, child);
		const event = makeForkEvent(parentSessionId, parentSequence, childSessionId);
		await this.append({ sessionId: childSessionId, expectedSequence: 0, events: [event] });
		return immutableSessionSnapshot({
			sessionId: childSessionId,
			parentSessionId,
			parentSequence,
			createdAt: event.occurredAt,
		});
	}

	async retain(sessionId: string, options: SessionRetentionOptions): Promise<number> {
		const data = this.data(sessionId);
		if (!Number.isSafeInteger(options.beforeSequence) || !Number.isSafeInteger(options.snapshotSequence))
			throw new AgentSessionContractError("retention sequences are invalid");
		if (options.beforeSequence < 1 || options.snapshotSequence < options.beforeSequence)
			throw new AgentSessionContractError("retention requires a snapshot at or after the retained boundary");
		if (!data.snapshot || data.snapshot.sequence < options.snapshotSequence)
			throw new SessionConcurrencyError("retention requires a current snapshot covering the deleted events");
		const before = data.events.length;
		data.events = data.events.filter((event) => event.sequence >= options.beforeSequence);
		return before - data.events.length;
	}

	async migrate(): Promise<void> {
		// Memory storage has no schema, but retaining this hook keeps all adapters interchangeable.
	}
}
