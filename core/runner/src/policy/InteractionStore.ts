import type {
	InteractionAnswer,
	InteractionRecord,
	InteractionStore,
	PolicyDecision,
	PolicyRequest,
} from "@blokjs/shared";
import type { InteractionRequest, InteractionSuspensionPort } from "@blokjs/shared";

export class InteractionConflictError extends Error {
	readonly code = "INTERACTION_CONFLICT";
}

export class InteractionAuthorizationError extends Error {
	readonly code = "INTERACTION_UNAUTHORIZED";
}

const MAX_ANSWER_BYTES = 64 * 1024;
function clone<T>(value: T): T {
	return structuredClone(value);
}
function assertBounded(answer: unknown): void {
	let serialized: string;
	try {
		serialized = JSON.stringify(answer ?? null);
	} catch {
		throw new InteractionConflictError("interaction answer must be JSON-serializable");
	}
	if (serialized.length > MAX_ANSWER_BYTES) throw new InteractionConflictError("interaction answer is too large");
}
function sameAnswer(record: InteractionRecord, answer: InteractionAnswer): boolean {
	return (
		record.answeredBy === answer.principalId &&
		JSON.stringify(record.answer ?? null) === JSON.stringify(answer.answer ?? null)
	);
}

/** Reference store with transactional state-machine semantics for tests and adapters. */
export class InMemoryInteractionStore implements InteractionStore {
	private readonly records = new Map<string, InteractionRecord>();

	async create(
		request: PolicyRequest,
		decision: PolicyDecision,
		opts?: { expiresAt?: string },
	): Promise<InteractionRecord> {
		const now = new Date().toISOString();
		const record: InteractionRecord = {
			version: "1",
			id: request.requestId,
			request: clone(request),
			decision: clone(decision),
			status: "pending",
			createdAt: now,
			expiresAt: opts?.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
			sequence: 0,
		};
		if (this.records.has(record.id)) throw new InteractionConflictError("interaction already exists");
		this.records.set(record.id, record);
		return clone(record);
	}

	async get(id: string): Promise<InteractionRecord | undefined> {
		const record = this.records.get(id);
		return record ? clone(record) : undefined;
	}

	async answer(answer: InteractionAnswer): Promise<InteractionRecord> {
		assertBounded(answer.answer);
		const record = this.records.get(answer.id);
		if (!record) throw new InteractionConflictError("interaction not found");
		if (record.status !== "pending") {
			if (sameAnswer(record, answer)) return clone(record);
			throw new InteractionConflictError("interaction is already resolved");
		}
		if (record.request.principal?.id !== answer.principalId)
			throw new InteractionAuthorizationError("interaction answer principal does not match the request");
		if (record.sequence !== answer.sequence) throw new InteractionConflictError("interaction sequence mismatch");
		if (Date.parse(record.expiresAt) <= Date.now()) {
			const expired = { ...record, status: "expired" as const, sequence: record.sequence + 1 };
			this.records.set(record.id, expired);
			throw new InteractionConflictError("interaction has expired");
		}
		const resolved: InteractionRecord = {
			...record,
			status: answer.deny ? "denied" : "answered",
			answer: clone(answer.answer),
			answeredBy: answer.principalId,
			answeredAt: new Date().toISOString(),
			sequence: record.sequence + 1,
		};
		this.records.set(record.id, resolved);
		return clone(resolved);
	}

	async cancel(id: string, principalId: string, sequence: number): Promise<InteractionRecord> {
		const record = this.records.get(id);
		if (!record) throw new InteractionConflictError("interaction not found");
		if (record.status !== "pending") return clone(record);
		if (record.request.principal?.id !== principalId)
			throw new InteractionAuthorizationError("interaction cancel principal does not match the request");
		if (record.sequence !== sequence) throw new InteractionConflictError("interaction sequence mismatch");
		const cancelled = { ...record, status: "cancelled" as const, sequence: record.sequence + 1 };
		this.records.set(id, cancelled);
		return clone(cancelled);
	}

	async expire(now = new Date().toISOString()): Promise<readonly InteractionRecord[]> {
		const timestamp = Date.parse(now);
		const expired: InteractionRecord[] = [];
		for (const record of this.records.values()) {
			if (record.status === "pending" && Date.parse(record.expiresAt) <= timestamp) {
				const next = { ...record, status: "expired" as const, sequence: record.sequence + 1 };
				this.records.set(record.id, next);
				expired.push(clone(next));
			}
		}
		return expired;
	}
}

export class DurableInteractionPort implements InteractionSuspensionPort {
	constructor(private readonly store: InteractionStore) {}
	async suspend(request: InteractionRequest): Promise<void> {
		await this.store.create(request.request, request.decision);
	}
}
