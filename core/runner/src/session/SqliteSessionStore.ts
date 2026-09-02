import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
	AgentSessionEvent,
	AppendSessionEventsInput,
	AppendSessionEventsResult,
	SessionCursor,
	SessionEventPage,
	SessionFork,
	SessionRetentionOptions,
	SessionSnapshot,
} from "@blokjs/shared";
import {
	AgentSessionContractError,
	SessionConcurrencyError,
	SessionCorruptTailError,
	immutableSessionSnapshot,
	parseSessionEvent,
	serializeSessionEvent,
} from "@blokjs/shared";
import {
	BaseSessionStore,
	checkDuplicate,
	eventFromInput,
	isUniqueConstraintError,
	readPage,
	validateAppend,
	validateSnapshot,
} from "./SessionStore";

interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): unknown;
	transaction<R>(fn: () => R): () => R;
	close(): void;
}

interface SqliteStatement {
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}

interface SessionEventRow {
	session_id: string;
	sequence: number;
	event_json: string;
}

const esmRequire = createRequire(import.meta.url);

/** SQLite reference adapter. The event table is authoritative; snapshots are disposable indexes. */
export class SqliteSessionStore extends BaseSessionStore {
	private readonly db: SqliteDatabase;

	constructor(dbPath = ".blok/sessions.db", db?: SqliteDatabase) {
		super();
		if (db) this.db = db;
		else {
			const isBun = "Bun" in globalThis;
			if (isBun) {
				const { Database } = esmRequire("bun:sqlite") as { Database: new (path: string) => SqliteDatabase };
				this.db = new Database(dbPath);
			} else {
				let Database: new (path: string) => SqliteDatabase;
				try {
					Database = esmRequire("better-sqlite3") as new (path: string) => SqliteDatabase;
				} catch {
					throw new Error("SqliteSessionStore requires 'better-sqlite3' or Bun's bun:sqlite");
				}
				this.db = new Database(dbPath);
			}
		}
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrateSync();
	}

	close(): void {
		this.db.close();
	}

	private migrateSync(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS agent_session_events (
				session_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				event_id TEXT NOT NULL,
				idempotency_key TEXT,
				event_json TEXT NOT NULL,
				PRIMARY KEY (session_id, sequence),
				UNIQUE (session_id, event_id),
				UNIQUE (session_id, idempotency_key)
			);
			CREATE INDEX IF NOT EXISTS idx_agent_session_events_id ON agent_session_events(session_id, event_id);
			CREATE TABLE IF NOT EXISTS agent_session_snapshots (
				session_id TEXT PRIMARY KEY,
				sequence INTEGER NOT NULL,
				snapshot_json TEXT NOT NULL
			);
		`);
	}

	async migrate(): Promise<void> {
		this.migrateSync();
	}

	private rows(sessionId: string): SessionEventRow[] {
		return this.db
			.prepare(
				"SELECT session_id, sequence, event_json FROM agent_session_events WHERE session_id = ? ORDER BY sequence",
			)
			.all(sessionId) as unknown as SessionEventRow[];
	}

	private parsedEvents(sessionId: string): {
		events: AgentSessionEvent[];
		corruptTail?: SessionCorruptTailError["tail"];
	} {
		const events: AgentSessionEvent[] = [];
		for (const row of this.rows(sessionId)) {
			try {
				const event = parseSessionEvent(JSON.parse(row.event_json));
				const previous = events.at(-1);
				if (event.sequence !== row.sequence || (previous && event.sequence <= previous.sequence))
					throw new AgentSessionContractError("event sequence is not ordered");
				events.push(event);
			} catch (error) {
				return {
					events,
					corruptTail: {
						sequence: row.sequence,
						reason: error instanceof Error ? error.message : "invalid event JSON",
					},
				};
			}
		}
		return { events };
	}

	private lastSequence(sessionId: string): number {
		const row = this.db
			.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_session_events WHERE session_id = ?")
			.get(sessionId);
		return Number(row?.sequence ?? 0);
	}

	async append(input: AppendSessionEventsInput): Promise<AppendSessionEventsResult> {
		const events = validateAppend(input);
		const append = this.db.transaction(() => {
			const parsed = this.parsedEvents(input.sessionId);
			if (parsed.corruptTail) throw new SessionCorruptTailError(parsed.corruptTail);
			const duplicate = checkDuplicate(parsed.events, events);
			if (duplicate)
				return {
					sessionId: input.sessionId,
					events: duplicate.events,
					sequence: this.lastSequence(input.sessionId),
					idempotent: true,
				};
			const actual = this.lastSequence(input.sessionId);
			if (actual !== input.expectedSequence)
				throw new SessionConcurrencyError(`expected sequence ${input.expectedSequence}, actual sequence ${actual}`);
			const appended = events.map((event, index) => eventFromInput(event, actual + index + 1));
			const insert = this.db.prepare(
				"INSERT INTO agent_session_events (session_id, sequence, event_id, idempotency_key, event_json) VALUES (?, ?, ?, ?, ?)",
			);
			try {
				for (const event of appended)
					insert.run(
						event.sessionId,
						event.sequence,
						event.id,
						event.idempotencyKey ?? null,
						serializeSessionEvent(event),
					);
			} catch (error) {
				if (isUniqueConstraintError(error)) throw new SessionConcurrencyError("session append sequence conflict");
				throw error;
			}
			return { sessionId: input.sessionId, events: appended, sequence: actual + appended.length, idempotent: false };
		});
		return immutableResult(append());
	}

	async read(sessionId: string, cursor?: SessionCursor | string): Promise<SessionEventPage> {
		const parsed = this.parsedEvents(sessionId);
		return readPage(sessionId, parsed.events, this.lastSequence(sessionId), cursor, parsed.corruptTail);
	}

	async getSnapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
		const row = this.db
			.prepare("SELECT snapshot_json FROM agent_session_snapshots WHERE session_id = ?")
			.get(sessionId);
		if (!row) return undefined;
		try {
			return validateSnapshot(JSON.parse(String(row.snapshot_json)) as SessionSnapshot);
		} catch (error) {
			throw new AgentSessionContractError(error instanceof Error ? error.message : "invalid session snapshot");
		}
	}

	async saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
		const safe = validateSnapshot(snapshot);
		if (safe.sequence > this.lastSequence(snapshot.sessionId))
			throw new AgentSessionContractError("snapshot is ahead of the session event log");
		const existing = await this.getSnapshot(snapshot.sessionId);
		if (existing && existing.sequence > safe.sequence)
			throw new SessionConcurrencyError("snapshot sequence moved backwards");
		this.db
			.prepare(
				"INSERT INTO agent_session_snapshots (session_id, sequence, snapshot_json) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET sequence = excluded.sequence, snapshot_json = excluded.snapshot_json WHERE excluded.sequence >= agent_session_snapshots.sequence",
			)
			.run(snapshot.sessionId, safe.sequence, JSON.stringify(safe));
	}

	async fork(parentSessionId: string, parentSequence: number, childSessionId: string): Promise<SessionFork> {
		if (this.lastSequence(childSessionId) > 0) throw new SessionConcurrencyError("child session already exists");
		if (
			!Number.isSafeInteger(parentSequence) ||
			parentSequence < 0 ||
			parentSequence > this.lastSequence(parentSessionId)
		)
			throw new AgentSessionContractError("parent sequence is outside the parent log");
		const event = {
			contractVersion: "1" as const,
			schemaVersion: 1 as const,
			id: randomUUID(),
			sessionId: childSessionId,
			kind: "session.forked" as const,
			visibility: "operational" as const,
			actor: { kind: "system" as const, id: "session-store" },
			occurredAt: new Date().toISOString(),
			payload: { parentSessionId, parentSequence },
		};
		await this.append({ sessionId: childSessionId, expectedSequence: 0, events: [event] });
		return immutableSessionSnapshot({
			sessionId: childSessionId,
			parentSessionId,
			parentSequence,
			createdAt: event.occurredAt,
		});
	}

	async retain(sessionId: string, options: SessionRetentionOptions): Promise<number> {
		if (options.beforeSequence < 1 || options.snapshotSequence < options.beforeSequence)
			throw new AgentSessionContractError("retention requires a snapshot at or after the retained boundary");
		const snapshot = await this.getSnapshot(sessionId);
		if (!snapshot || snapshot.sequence < options.snapshotSequence)
			throw new SessionConcurrencyError("retention requires a current snapshot covering the deleted events");
		return this.db
			.prepare("DELETE FROM agent_session_events WHERE session_id = ? AND sequence < ?")
			.run(sessionId, options.beforeSequence).changes;
	}
}

function immutableResult(result: AppendSessionEventsResult): AppendSessionEventsResult {
	return Object.freeze({ ...result, events: Object.freeze([...result.events]) });
}
