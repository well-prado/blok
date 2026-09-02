import { randomUUID } from "node:crypto";
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

export interface SessionPgResult<Row = Record<string, unknown>> {
	readonly rows: Row[];
	readonly rowCount?: number;
}

export interface SessionPgClient {
	query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SessionPgResult<Row>>;
}

interface SessionPgPool extends SessionPgClient {
	connect(): Promise<SessionPgConnection>;
	end?(): Promise<void>;
}

interface SessionPgConnection extends SessionPgClient {
	release(): void;
}

interface SessionEventRow {
	session_id: string;
	sequence: number | string;
	event_json: string;
}

interface SnapshotRow {
	snapshot_json: string;
}

/** Postgres reference adapter. Pass a pg Pool or a transaction-capable client. */
export class PostgresSessionStore extends BaseSessionStore {
	private readonly client: SessionPgClient;
	private readonly pool?: SessionPgPool;
	private readonly ready: Promise<void>;

	constructor(client: SessionPgClient) {
		super();
		this.client = client;
		if ("connect" in client && typeof client.connect === "function") this.pool = client as SessionPgPool;
		this.ready = this.migrateSchema();
	}

	private async migrateSchema(): Promise<void> {
		await this.client.query(`
			CREATE TABLE IF NOT EXISTS agent_session_events (
				session_id TEXT NOT NULL,
				sequence BIGINT NOT NULL,
				event_id TEXT NOT NULL,
				idempotency_key TEXT,
				event_json JSONB NOT NULL,
				PRIMARY KEY (session_id, sequence),
				UNIQUE (session_id, event_id),
				UNIQUE (session_id, idempotency_key)
			);
			CREATE TABLE IF NOT EXISTS agent_session_snapshots (
				session_id TEXT PRIMARY KEY,
				sequence BIGINT NOT NULL,
				snapshot_json JSONB NOT NULL
			);
		`);
	}

	async migrate(): Promise<void> {
		await this.ready;
		await this.migrateSchema();
	}

	async close(): Promise<void> {
		await this.pool?.end?.();
	}

	private async rows(client: SessionPgClient, sessionId: string): Promise<SessionEventRow[]> {
		const result = await client.query<SessionEventRow>(
			"SELECT session_id, sequence, event_json::text AS event_json FROM agent_session_events WHERE session_id = $1 ORDER BY sequence",
			[sessionId],
		);
		return result.rows;
	}

	private async parsedEvents(
		client: SessionPgClient,
		sessionId: string,
	): Promise<{ events: AgentSessionEvent[]; corruptTail?: SessionCorruptTailError["tail"] }> {
		const events: AgentSessionEvent[] = [];
		for (const row of await this.rows(client, sessionId)) {
			try {
				const event = parseSessionEvent(JSON.parse(row.event_json));
				const previous = events.at(-1);
				if (event.sequence !== Number(row.sequence) || (previous && event.sequence <= previous.sequence))
					throw new AgentSessionContractError("event sequence is not ordered");
				events.push(event);
			} catch (error) {
				return {
					events,
					corruptTail: {
						sequence: Number(row.sequence),
						reason: error instanceof Error ? error.message : "invalid event JSON",
					},
				};
			}
		}
		return { events };
	}

	private async lastSequence(client: SessionPgClient, sessionId: string): Promise<number> {
		const result = await client.query<{ sequence: number | string }>(
			"SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_session_events WHERE session_id = $1",
			[sessionId],
		);
		return Number(result.rows[0]?.sequence ?? 0);
	}

	private async transaction<R>(work: (client: SessionPgClient) => Promise<R>): Promise<R> {
		const connection = this.pool ? await this.pool.connect() : undefined;
		const client = connection ?? this.client;
		try {
			await client.query("BEGIN");
			const result = await work(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// Preserve the original append error.
			}
			throw error;
		} finally {
			connection?.release();
		}
	}

	async append(input: AppendSessionEventsInput): Promise<AppendSessionEventsResult> {
		await this.ready;
		const events = validateAppend(input);
		return this.transaction(async (client) => {
			const parsed = await this.parsedEvents(client, input.sessionId);
			if (parsed.corruptTail) throw new SessionCorruptTailError(parsed.corruptTail);
			const duplicate = checkDuplicate(parsed.events, events);
			if (duplicate)
				return immutableResult({
					sessionId: input.sessionId,
					events: duplicate.events,
					sequence: await this.lastSequence(client, input.sessionId),
					idempotent: true,
				});
			const actual = await this.lastSequence(client, input.sessionId);
			if (actual !== input.expectedSequence)
				throw new SessionConcurrencyError(`expected sequence ${input.expectedSequence}, actual sequence ${actual}`);
			const appended = events.map((event, index) => eventFromInput(event, actual + index + 1));
			try {
				for (const event of appended)
					await client.query(
						"INSERT INTO agent_session_events (session_id, sequence, event_id, idempotency_key, event_json) VALUES ($1, $2, $3, $4, $5::jsonb)",
						[event.sessionId, event.sequence, event.id, event.idempotencyKey ?? null, serializeSessionEvent(event)],
					);
			} catch (error) {
				if (isUniqueConstraintError(error)) throw new SessionConcurrencyError("session append sequence conflict");
				throw error;
			}
			return immutableResult({
				sessionId: input.sessionId,
				events: appended,
				sequence: actual + appended.length,
				idempotent: false,
			});
		});
	}

	async read(sessionId: string, cursor?: SessionCursor | string): Promise<SessionEventPage> {
		await this.ready;
		const parsed = await this.parsedEvents(this.client, sessionId);
		return readPage(
			sessionId,
			parsed.events,
			await this.lastSequence(this.client, sessionId),
			cursor,
			parsed.corruptTail,
		);
	}

	async getSnapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
		await this.ready;
		const result = await this.client.query<SnapshotRow>(
			"SELECT snapshot_json::text AS snapshot_json FROM agent_session_snapshots WHERE session_id = $1",
			[sessionId],
		);
		const raw = result.rows[0]?.snapshot_json;
		if (!raw) return undefined;
		try {
			return validateSnapshot(JSON.parse(raw) as SessionSnapshot);
		} catch (error) {
			throw new AgentSessionContractError(error instanceof Error ? error.message : "invalid session snapshot");
		}
	}

	async saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
		await this.ready;
		const safe = validateSnapshot(snapshot);
		if (safe.sequence > (await this.lastSequence(this.client, snapshot.sessionId)))
			throw new AgentSessionContractError("snapshot is ahead of the session event log");
		const existing = await this.getSnapshot(snapshot.sessionId);
		if (existing && existing.sequence > safe.sequence)
			throw new SessionConcurrencyError("snapshot sequence moved backwards");
		await this.client.query(
			"INSERT INTO agent_session_snapshots (session_id, sequence, snapshot_json) VALUES ($1, $2, $3::jsonb) ON CONFLICT (session_id) DO UPDATE SET sequence = EXCLUDED.sequence, snapshot_json = EXCLUDED.snapshot_json WHERE EXCLUDED.sequence >= agent_session_snapshots.sequence",
			[snapshot.sessionId, safe.sequence, JSON.stringify(safe)],
		);
	}

	async fork(parentSessionId: string, parentSequence: number, childSessionId: string): Promise<SessionFork> {
		await this.ready;
		if ((await this.lastSequence(this.client, childSessionId)) > 0)
			throw new SessionConcurrencyError("child session already exists");
		if (
			!Number.isSafeInteger(parentSequence) ||
			parentSequence < 0 ||
			parentSequence > (await this.lastSequence(this.client, parentSessionId))
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
		await this.ready;
		if (options.beforeSequence < 1 || options.snapshotSequence < options.beforeSequence)
			throw new AgentSessionContractError("retention requires a snapshot at or after the retained boundary");
		const snapshot = await this.getSnapshot(sessionId);
		if (!snapshot || snapshot.sequence < options.snapshotSequence)
			throw new SessionConcurrencyError("retention requires a current snapshot covering the deleted events");
		const result = await this.client.query("DELETE FROM agent_session_events WHERE session_id = $1 AND sequence < $2", [
			sessionId,
			options.beforeSequence,
		]);
		return result.rowCount ?? 0;
	}
}

function immutableResult(result: AppendSessionEventsResult): AppendSessionEventsResult {
	return Object.freeze({ ...result, events: Object.freeze([...result.events]) });
}
