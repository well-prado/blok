import { createRequire } from "node:module";
import type {
	InteractionAnswer,
	InteractionRecord,
	InteractionStatus,
	InteractionStore,
	PolicyDecision,
	PolicyRequest,
} from "@blokjs/shared";
import { InteractionAuthorizationError, InteractionConflictError } from "./InteractionStore";

const esmRequire = createRequire(import.meta.url);
const isBun = "Bun" in globalThis;
const MAX_ANSWER_BYTES = 64 * 1024;

/** The small common subset used by bun:sqlite and better-sqlite3. */
interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): unknown;
	transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
	close(): void;
}

interface SqliteStatement {
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}

interface InteractionRow {
	version: string;
	id: string;
	principal_id: string | null;
	request_json: string;
	decision_json: string;
	status: InteractionStatus;
	created_at: string;
	expires_at: string;
	sequence: number;
	answer_json: string | null;
	answered_by: string | null;
	answered_at: string | null;
	claimed_by: string | null;
	claimed_at: string | null;
}

type ClaimedInteractionRecord = InteractionRecord & {
	readonly claimedBy?: string;
	readonly claimedAt?: string;
};
type MutableInteractionRecord = { -readonly [Key in keyof ClaimedInteractionRecord]: ClaimedInteractionRecord[Key] };

function clone<T>(value: T): T {
	return structuredClone(value);
}

function json(value: unknown, label: string): string {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error(`${label} is not JSON-serializable`);
		return serialized;
	} catch {
		throw new InteractionConflictError(`${label} must be JSON-serializable`);
	}
}

function answerJson(answer: unknown): string | null {
	return answer === undefined ? null : json(answer, "interaction answer");
}

function assertBoundedAnswer(answer: unknown): string | null {
	const serialized = answerJson(answer);
	const bytes = new TextEncoder().encode(serialized ?? "null").byteLength;
	if (bytes > MAX_ANSWER_BYTES) throw new InteractionConflictError("interaction answer is too large");
	return serialized;
}

function sameAnswer(record: InteractionRecord, answer: InteractionAnswer): boolean {
	const expectedStatus = answer.deny ? "denied" : "answered";
	return (
		record.status === expectedStatus &&
		record.answeredBy === answer.principalId &&
		JSON.stringify(record.answer ?? null) === JSON.stringify(answer.answer ?? null)
	);
}

function parseJson<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(`invalid ${label} in interaction store`);
	}
}

function rowToRecord(row: InteractionRow): ClaimedInteractionRecord {
	const record: MutableInteractionRecord = {
		version: "1",
		id: row.id,
		request: parseJson<PolicyRequest>(row.request_json, "interaction request"),
		decision: parseJson<PolicyDecision>(row.decision_json, "interaction decision"),
		status: row.status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		sequence: row.sequence,
	};
	if (row.answer_json !== null) record.answer = parseJson<unknown>(row.answer_json, "interaction answer");
	if (row.answered_by !== null) record.answeredBy = row.answered_by;
	if (row.answered_at !== null) record.answeredAt = row.answered_at;
	if (row.claimed_by !== null) record.claimedBy = row.claimed_by;
	if (row.claimed_at !== null) record.claimedAt = row.claimed_at;
	return clone(record);
}

/**
 * SQLite-backed interaction state store.
 *
 * This adapter owns persistence and state transitions only. It deliberately
 * does not know how a workflow cursor is resumed after an interaction settles.
 */
export class SqliteInteractionStore implements InteractionStore {
	private readonly db: SqliteDatabase;
	private readonly statements: Record<string, SqliteStatement> = {};

	constructor(dbPath = ".blok/trace.db") {
		if (isBun) {
			const bunMod = "bun:sqlite";
			const { Database } = esmRequire(bunMod) as {
				Database: new (path: string) => SqliteDatabase;
			};
			this.db = new Database(dbPath);
		} else {
			let Database: new (path: string) => SqliteDatabase;
			try {
				Database = esmRequire("better-sqlite3") as new (path: string) => SqliteDatabase;
			} catch {
				throw new Error(
					"SqliteInteractionStore requires 'better-sqlite3'. Install it:\n" +
						"  npm install better-sqlite3\n" +
						"  # or\n" +
						"  bun add better-sqlite3",
				);
			}
			this.db = new Database(dbPath);
		}

		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	close(): void {
		this.db.close();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS policy_interactions (
				id TEXT PRIMARY KEY,
				version TEXT NOT NULL,
				principal_id TEXT,
				request_json TEXT NOT NULL,
				decision_json TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'denied', 'expired', 'cancelled')),
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				answer_json TEXT,
				answered_by TEXT,
				answered_at TEXT,
				claimed_by TEXT,
				claimed_at TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_policy_interactions_status_expiry
				ON policy_interactions(status, expires_at);
		`);
		const columns = new Set(
			(this.db.prepare("PRAGMA table_info(policy_interactions)").all() as unknown as Array<{ name: string }>).map(
				(column) => column.name,
			),
		);
		if (!columns.has("principal_id")) {
			this.db.exec("ALTER TABLE policy_interactions ADD COLUMN principal_id TEXT");
			this.db.exec(
				"UPDATE policy_interactions SET principal_id = json_extract(request_json, '$.principal.id') WHERE principal_id IS NULL",
			);
		}
		if (!columns.has("claimed_by")) this.db.exec("ALTER TABLE policy_interactions ADD COLUMN claimed_by TEXT");
		if (!columns.has("claimed_at")) this.db.exec("ALTER TABLE policy_interactions ADD COLUMN claimed_at TEXT");
	}

	private stmt(key: string, sql: string): SqliteStatement {
		const existing = this.statements[key];
		if (existing) return existing;
		const statement = this.db.prepare(sql);
		this.statements[key] = statement;
		return statement;
	}

	private find(id: string): ClaimedInteractionRecord | undefined {
		const row = this.stmt(
			"get",
			"SELECT version, id, principal_id, request_json, decision_json, status, created_at, expires_at, sequence, answer_json, answered_by, answered_at, claimed_by, claimed_at FROM policy_interactions WHERE id = ?",
		).get(id) as InteractionRow | undefined;
		return row ? rowToRecord(row) : undefined;
	}

	async create(
		request: PolicyRequest,
		decision: PolicyDecision,
		opts?: { expiresAt?: string },
	): Promise<InteractionRecord> {
		const createdAt = new Date().toISOString();
		const record: InteractionRecord = {
			version: "1",
			id: request.requestId,
			request: clone(request),
			decision: clone(decision),
			status: "pending",
			createdAt,
			expiresAt: opts?.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
			sequence: 0,
		};
		const result = this.stmt(
			"create",
			"INSERT OR IGNORE INTO policy_interactions (id, version, principal_id, request_json, decision_json, status, created_at, expires_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			record.id,
			record.version,
			request.principal?.id ?? null,
			json(record.request, "interaction request"),
			json(record.decision, "interaction decision"),
			record.status,
			record.createdAt,
			record.expiresAt,
			record.sequence,
		);
		if (result.changes !== 1) throw new InteractionConflictError("interaction already exists");
		return clone(record);
	}

	async get(id: string): Promise<InteractionRecord | undefined> {
		return this.find(id);
	}

	async answer(answer: InteractionAnswer): Promise<InteractionRecord> {
		const serializedAnswer = assertBoundedAnswer(answer.answer);
		const record = this.find(answer.id);
		if (!record) throw new InteractionConflictError("interaction not found");
		if (record.status !== "pending") {
			if (sameAnswer(record, answer)) return clone(record);
			throw new InteractionConflictError("interaction is already resolved");
		}
		if (record.request.principal?.id !== answer.principalId)
			throw new InteractionAuthorizationError("interaction answer principal does not match the request");
		if (record.sequence !== answer.sequence) throw new InteractionConflictError("interaction sequence mismatch");

		if (Date.parse(record.expiresAt) <= Date.now()) {
			const expired = this.stmt(
				"expireOne",
				"UPDATE policy_interactions SET status = 'expired', sequence = sequence + 1 WHERE id = ? AND status = 'pending' AND sequence = ?",
			).run(record.id, record.sequence);
			if (expired.changes !== 1) {
				const current = this.find(record.id);
				if (current && sameAnswer(current, answer)) return clone(current);
			}
			throw new InteractionConflictError("interaction has expired");
		}

		const answeredAt = new Date().toISOString();
		const updated = this.stmt(
			"answer",
			"UPDATE policy_interactions SET status = ?, answer_json = ?, answered_by = ?, answered_at = ?, sequence = sequence + 1 WHERE id = ? AND status = 'pending' AND sequence = ?",
		).run(
			answer.deny ? "denied" : "answered",
			serializedAnswer,
			answer.principalId,
			answeredAt,
			record.id,
			record.sequence,
		);
		if (updated.changes !== 1) {
			const current = this.find(record.id);
			if (current && sameAnswer(current, answer)) return clone(current);
			throw new InteractionConflictError("interaction sequence mismatch");
		}
		const resolved = this.find(record.id);
		if (!resolved) throw new InteractionConflictError("interaction not found");
		return resolved;
	}

	/**
	 * Atomically fences one resume attempt. The public interaction contract's
	 * `claim` addition is supplied by the resume coordinator stream; keeping
	 * this method here makes SQLite safe to use when that stream lands without
	 * coupling this adapter to runner cursor/orchestration code.
	 */
	async claim(id: string, principalId: string, sequence: number): Promise<ClaimedInteractionRecord> {
		const record = this.find(id);
		if (!record) throw new InteractionConflictError("interaction not found");
		if (record.request.principal?.id !== principalId)
			throw new InteractionAuthorizationError("interaction claim principal does not match the request");
		if (record.status !== "answered")
			throw new InteractionConflictError(`interaction cannot resume from status ${record.status}`);
		if (record.sequence !== sequence) throw new InteractionConflictError("interaction sequence mismatch");
		if (Date.parse(record.expiresAt) <= Date.now()) throw new InteractionConflictError("interaction has expired");

		const claimedAt = new Date().toISOString();
		const updated = this.stmt(
			"claim",
			"UPDATE policy_interactions SET claimed_by = ?, claimed_at = ?, sequence = sequence + 1 WHERE id = ? AND principal_id = ? AND status = 'answered' AND sequence = ? AND expires_at > ?",
		).run(principalId, claimedAt, id, principalId, sequence, new Date().toISOString());
		if (updated.changes !== 1) {
			const current = this.find(id);
			if (!current) throw new InteractionConflictError("interaction not found");
			if (current.request.principal?.id !== principalId)
				throw new InteractionAuthorizationError("interaction claim principal does not match the request");
			if (current.status !== "answered")
				throw new InteractionConflictError(`interaction cannot resume from status ${current.status}`);
			if (Date.parse(current.expiresAt) <= Date.now()) throw new InteractionConflictError("interaction has expired");
			throw new InteractionConflictError("interaction sequence mismatch");
		}
		const claimed = this.find(id);
		if (!claimed) throw new InteractionConflictError("interaction not found");
		return claimed;
	}

	async cancel(id: string, principalId: string, sequence: number): Promise<InteractionRecord> {
		const record = this.find(id);
		if (!record) throw new InteractionConflictError("interaction not found");
		if (record.status !== "pending") return clone(record);
		if (record.request.principal?.id !== principalId)
			throw new InteractionAuthorizationError("interaction cancel principal does not match the request");
		if (record.sequence !== sequence) throw new InteractionConflictError("interaction sequence mismatch");
		const updated = this.stmt(
			"cancel",
			"UPDATE policy_interactions SET status = 'cancelled', sequence = sequence + 1 WHERE id = ? AND status = 'pending' AND sequence = ?",
		).run(id, sequence);
		if (updated.changes !== 1) throw new InteractionConflictError("interaction sequence mismatch");
		const cancelled = this.find(id);
		if (!cancelled) throw new InteractionConflictError("interaction not found");
		return cancelled;
	}

	async expire(now = new Date().toISOString()): Promise<readonly InteractionRecord[]> {
		const timestamp = Date.parse(now);
		const rows = this.stmt(
			"pending",
			"SELECT version, id, principal_id, request_json, decision_json, status, created_at, expires_at, sequence, answer_json, answered_by, answered_at, claimed_by, claimed_at FROM policy_interactions WHERE status = 'pending'",
		).all() as unknown as InteractionRow[];
		const expired: InteractionRecord[] = [];
		const expirePending = this.stmt(
			"expirePending",
			"UPDATE policy_interactions SET status = 'expired', sequence = sequence + 1 WHERE id = ? AND status = 'pending' AND sequence = ?",
		);
		const apply = this.db.transaction(() => {
			for (const row of rows) {
				if (Date.parse(row.expires_at) <= timestamp && expirePending.run(row.id, row.sequence).changes === 1) {
					const record = this.find(row.id);
					if (record) expired.push(record);
				}
			}
		});
		apply();
		return expired.map((record) => clone(record));
	}
}
