import type { SessionEventInput, SessionStore } from "@blokjs/shared";
import {
	AgentSessionContractError,
	SessionConcurrencyError,
	SessionCorruptTailError,
	foldSessionEvents,
	parseSessionEvent,
} from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../../../src/session/MemorySessionStore";
import { PostgresSessionStore, type SessionPgClient } from "../../../src/session/PostgresSessionStore";
import { SqliteSessionStore } from "../../../src/session/SqliteSessionStore";

const event = (id: string, sessionId = "s-1", overrides: Partial<SessionEventInput> = {}): SessionEventInput => ({
	contractVersion: "1",
	schemaVersion: 1,
	id,
	sessionId,
	kind: "message.user",
	visibility: "model-visible",
	actor: { kind: "user", id: "u-1" },
	occurredAt: "2026-08-31T12:00:00.000Z",
	payload: { text: id },
	...overrides,
});

function stores(): Array<{ name: string; create: () => SessionStore; close: (store: SessionStore) => void }> {
	return [
		{ name: "memory", create: () => new MemorySessionStore(), close: () => undefined },
		{ name: "postgres", create: () => new PostgresSessionStore(new FakePostgres()), close: () => undefined },
		{ name: "sqlite", create: () => new SqliteSessionStore(":memory:"), close: (store) => store.close?.() },
	];
}

/** Minimal SQL contract double: it exercises the Postgres adapter without requiring a server in unit CI. */
class FakePostgres implements SessionPgClient {
	private readonly events: Array<{
		session_id: string;
		sequence: number;
		event_id: string;
		idempotency_key: string | null;
		event_json: string;
	}> = [];
	private readonly snapshots = new Map<string, { sequence: number; snapshot_json: string }>();

	async query<Row = Record<string, unknown>>(
		text: string,
		values: readonly unknown[] = [],
	): Promise<{ rows: Row[]; rowCount?: number }> {
		const sql = text.trim();
		if (sql.startsWith("CREATE TABLE") || ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] as Row[] };
		if (sql.startsWith("SELECT session_id, sequence")) {
			const sessionId = String(values[0]);
			return {
				rows: this.events
					.filter((event) => event.session_id === sessionId)
					.sort((left, right) => left.sequence - right.sequence)
					.map(({ session_id, sequence, event_json }) => ({ session_id, sequence, event_json }) as Row),
			};
		}
		if (sql.startsWith("SELECT COALESCE(MAX(sequence)")) {
			const sessionId = String(values[0]);
			const sequence = Math.max(
				0,
				...this.events.filter((event) => event.session_id === sessionId).map((event) => event.sequence),
			);
			return { rows: [{ sequence } as Row] };
		}
		if (sql.startsWith("INSERT INTO agent_session_events")) {
			const [session_id, sequence, event_id, idempotency_key, event_json] = values;
			if (
				this.events.some(
					(event) =>
						event.session_id === session_id &&
						(event.sequence === sequence ||
							event.event_id === event_id ||
							(idempotency_key !== null && event.idempotency_key === idempotency_key)),
				)
			) {
				throw Object.assign(new Error("unique violation"), { code: "23505" });
			}
			this.events.push({
				session_id: String(session_id),
				sequence: Number(sequence),
				event_id: String(event_id),
				idempotency_key: idempotency_key === null ? null : String(idempotency_key),
				event_json: String(event_json),
			});
			return { rows: [], rowCount: 1 };
		}
		if (sql.startsWith("SELECT snapshot_json")) {
			const snapshot = this.snapshots.get(String(values[0]));
			return { rows: snapshot ? [{ snapshot_json: snapshot.snapshot_json } as Row] : [] };
		}
		if (sql.startsWith("INSERT INTO agent_session_snapshots")) {
			const sessionId = String(values[0]);
			const sequence = Number(values[1]);
			const current = this.snapshots.get(sessionId);
			if (!current || sequence >= current.sequence)
				this.snapshots.set(sessionId, { sequence, snapshot_json: String(values[2]) });
			return { rows: [], rowCount: 1 };
		}
		if (sql.startsWith("DELETE FROM agent_session_events")) {
			const sessionId = String(values[0]);
			const before = Number(values[1]);
			const retained = this.events.filter((event) => event.session_id !== sessionId || event.sequence >= before);
			const rowCount = this.events.length - retained.length;
			this.events.splice(0, this.events.length, ...retained);
			return { rows: [], rowCount };
		}
		throw new Error(`unhandled fake SQL: ${sql}`);
	}
}

describe("agent session event contract", () => {
	it("requires bounded, explicit envelopes and rejects hidden reasoning", () => {
		expect(() => parseSessionEvent({ ...event("e-1"), sequence: 1, payload: { reasoning: "private" } })).toThrow(
			AgentSessionContractError,
		);
		expect(() => parseSessionEvent({ ...event("e-1"), sequence: 1, occurredAt: "2026-08-31" })).toThrow(
			"canonical ISO timestamp",
		);
	});

	it("folds only model-visible transcript facts and is order-deterministic", () => {
		const visible = parseSessionEvent({ ...event("e-1"), sequence: 1 });
		const operational = parseSessionEvent({
			...event("e-2"),
			sequence: 2,
			kind: "policy.decision",
			visibility: "operational",
			payload: { allowed: true },
		});
		const first = foldSessionEvents([visible, operational]);
		const second = foldSessionEvents([visible, operational]);
		expect(first).toEqual(second);
		expect(first.messages).toHaveLength(1);
		expect(first.lastSequence).toBe(2);
	});
});

describe.each(stores())("$name session store", ({ create, close }) => {
	it("supports optimistic append, idempotency, and cursor reads", async () => {
		const store = create();
		try {
			const first = await store.append({ sessionId: "s-1", expectedSequence: 0, events: [event("e-1")] });
			expect(first.events[0]?.sequence).toBe(1);
			const duplicate = await store.append({ sessionId: "s-1", expectedSequence: 0, events: [event("e-1")] });
			expect(duplicate.idempotent).toBe(true);
			expect(duplicate.events[0]?.sequence).toBe(1);
			await expect(store.append({ sessionId: "s-1", expectedSequence: 0, events: [event("e-2")] })).rejects.toThrow(
				SessionConcurrencyError,
			);
			await store.append({
				sessionId: "s-1",
				expectedSequence: 1,
				events: [event("e-2", "s-1", { kind: "policy.decision", visibility: "operational" })],
			});
			const page = await store.read("s-1", { afterSequence: 0, limit: 1 });
			expect(page.events.map((item) => item.id)).toEqual(["e-1"]);
			expect(page.nextCursor).toBe("s1");
			expect((await store.read("s-1", page.nextCursor)).events.map((item) => item.id)).toEqual(["e-2"]);
		} finally {
			await close(store);
		}
	});

	it("rebuilds from a snapshot, retains covered history, and records immutable forks", async () => {
		const store = create();
		try {
			await store.append({ sessionId: "s-1", expectedSequence: 0, events: [event("e-1"), event("e-2")] });
			await store.fork("s-1", 1, "historical-child");
			expect((await store.fold("historical-child")).messages.map((item) => item.id)).toEqual(["e-1"]);
			const state = await store.fold("s-1");
			await store.saveSnapshot({
				contractVersion: "1",
				schemaVersion: 1,
				sessionId: "s-1",
				sequence: 2,
				state,
				createdAt: "2026-08-31T12:01:00.000Z",
			});
			expect(await store.retain("s-1", { beforeSequence: 2, snapshotSequence: 2 })).toBe(1);
			expect((await store.fold("s-1")).messages.map((item) => item.id)).toEqual(["e-1", "e-2"]);
			const fork = await store.fork("s-1", 2, "child");
			expect(fork).toMatchObject({ sessionId: "child", parentSessionId: "s-1", parentSequence: 2 });
			expect((await store.read("s-1")).events.map((item) => item.id)).toEqual(["e-2"]);
			expect((await store.fold("child")).lineage).toMatchObject({ parentSessionId: "s-1", parentSequence: 2 });
		} finally {
			await close(store);
		}
	});
});

describe("corrupt-tail contract", () => {
	it("exposes a corrupt SQLite tail without deleting committed prefix", async () => {
		const store = new SqliteSessionStore(":memory:");
		try {
			await store.append({ sessionId: "s-1", expectedSequence: 0, events: [event("e-1")] });
			const db = (store as unknown as { db: { prepare(sql: string): { run(...params: unknown[]): unknown } } }).db;
			db.prepare(
				"INSERT INTO agent_session_events (session_id, sequence, event_id, event_json) VALUES (?, ?, ?, ?)",
			).run("s-1", 2, "bad", "not-json");
			const page = await store.read("s-1");
			expect(page.events.map((item) => item.id)).toEqual(["e-1"]);
			expect(page.corruptTail).toMatchObject({ sequence: 2 });
			await expect(store.append({ sessionId: "s-1", expectedSequence: 1, events: [event("e-2")] })).rejects.toThrow(
				SessionCorruptTailError,
			);
		} finally {
			store.close();
		}
	});
});
