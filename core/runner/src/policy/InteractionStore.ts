import type {
	InteractionAnswer,
	InteractionRecord,
	InteractionStore,
	PolicyDecision,
	PolicyRequest,
} from "@blokjs/shared";
import type { InteractionRequest, InteractionSuspensionPort } from "@blokjs/shared";
import {
	fingerprintInteractionPayload,
	immutableInteractionSnapshot,
	parseInteractionAnswer,
	redactInteractionDecision,
	redactInteractionPayload,
	redactInteractionRequest,
} from "@blokjs/shared";

export class InteractionConflictError extends Error {
	readonly code = "INTERACTION_CONFLICT";
}

export class InteractionAuthorizationError extends Error {
	readonly code = "INTERACTION_UNAUTHORIZED";
}

export type InteractionReauthorize = (request: PolicyRequest) => void | Promise<void>;

export type InteractionResumeCallback = (input: {
	readonly request: PolicyRequest;
	readonly answer: unknown;
	readonly interaction: InteractionRecord;
}) => void | Promise<void>;

export interface InteractionResumeRequest {
	readonly id: string;
	readonly principalId: string;
	readonly sequence: number;
}

function clone<T>(value: T): T {
	return immutableInteractionSnapshot(value);
}
function sameAnswer(record: InteractionRecord, answer: InteractionAnswer): boolean {
	return (
		record.answeredBy === answer.principalId &&
		record.status === (answer.deny ? "denied" : "answered") &&
		fingerprintInteractionPayload(record.answer) ===
			fingerprintInteractionPayload(answer.answer === undefined ? undefined : redactInteractionPayload(answer.answer))
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
		if (typeof request.requestId !== "string" || request.requestId.length === 0 || request.requestId.length > 256)
			throw new InteractionConflictError("interaction request id is invalid");
		const safeRequest = redactInteractionRequest(request);
		const safeDecision = redactInteractionDecision(decision);
		const expiresAt = opts?.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString();
		if (!Number.isFinite(Date.parse(expiresAt))) throw new InteractionConflictError("interaction expiry is invalid");
		const record: InteractionRecord = {
			version: "1",
			id: request.requestId,
			request: safeRequest,
			decision: safeDecision,
			status: "pending",
			createdAt: now,
			expiresAt,
			sequence: 0,
			suspension: request.suspension ? clone(request.suspension) : undefined,
		};
		if (this.records.has(record.id)) throw new InteractionConflictError("interaction already exists");
		this.records.set(record.id, clone(record));
		return clone(record);
	}

	async get(id: string): Promise<InteractionRecord | undefined> {
		const record = this.records.get(id);
		return record ? clone(record) : undefined;
	}

	async answer(answer: InteractionAnswer): Promise<InteractionRecord> {
		let parsed: InteractionAnswer;
		try {
			parsed = parseInteractionAnswer(answer);
		} catch (error) {
			throw new InteractionConflictError(error instanceof Error ? error.message : "invalid interaction answer");
		}
		const record = this.records.get(parsed.id);
		if (!record) throw new InteractionConflictError("interaction not found");
		if (record.status !== "pending") {
			if (sameAnswer(record, parsed)) return clone(record);
			throw new InteractionConflictError("interaction is already resolved");
		}
		if (record.request.principal?.id !== parsed.principalId)
			throw new InteractionAuthorizationError("interaction answer principal does not match the request");
		if (record.sequence !== parsed.sequence) throw new InteractionConflictError("interaction sequence mismatch");
		if (Date.parse(record.expiresAt) <= Date.now()) {
			const expired = { ...record, status: "expired" as const, sequence: record.sequence + 1 };
			this.records.set(record.id, clone(expired));
			throw new InteractionConflictError("interaction has expired");
		}
		const safeAnswer = parsed.answer === undefined ? undefined : redactInteractionPayload(parsed.answer);
		const resolved: InteractionRecord = {
			...record,
			status: parsed.deny ? "denied" : "answered",
			...(safeAnswer === undefined ? {} : { answer: safeAnswer }),
			answeredBy: parsed.principalId,
			answeredAt: new Date().toISOString(),
			sequence: record.sequence + 1,
		};
		this.records.set(record.id, clone(resolved));
		return clone(resolved);
	}

	/** Atomically fence one resume consumer without changing the answered status. */
	async claim(id: string, principalId: string, sequence: number): Promise<InteractionRecord> {
		const record = this.records.get(id);
		if (!record) throw new InteractionConflictError("interaction not found");
		if (record.request.principal?.id !== principalId)
			throw new InteractionAuthorizationError("interaction claim principal does not match the request");
		if (record.status !== "answered")
			throw new InteractionConflictError(`interaction cannot resume from status ${record.status}`);
		if (record.claimedBy !== undefined) throw new InteractionConflictError("interaction has already been claimed");
		if (record.sequence !== sequence) throw new InteractionConflictError("interaction sequence mismatch");
		if (Date.parse(record.expiresAt) <= Date.now()) throw new InteractionConflictError("interaction has expired");
		const claimed: InteractionRecord = {
			...record,
			claimedBy: principalId,
			claimedAt: new Date().toISOString(),
			sequence: record.sequence + 1,
		};
		this.records.set(id, clone(claimed));
		return clone(claimed);
	}

	async cancel(id: string, principalId: string, sequence: number): Promise<InteractionRecord> {
		const record = this.records.get(id);
		if (!record) throw new InteractionConflictError("interaction not found");
		if (record.request.principal?.id !== principalId)
			throw new InteractionAuthorizationError("interaction cancel principal does not match the request");
		if (record.status !== "pending") return clone(record);
		if (record.sequence !== sequence) throw new InteractionConflictError("interaction sequence mismatch");
		const cancelled = { ...record, status: "cancelled" as const, sequence: record.sequence + 1 };
		this.records.set(id, clone(cancelled));
		return clone(cancelled);
	}

	async expire(now = new Date().toISOString()): Promise<readonly InteractionRecord[]> {
		const timestamp = Date.parse(now);
		if (!Number.isFinite(timestamp)) throw new InteractionConflictError("interaction expiry timestamp is invalid");
		const expired: InteractionRecord[] = [];
		for (const record of this.records.values()) {
			if (record.status === "pending" && Date.parse(record.expiresAt) <= timestamp) {
				const next = { ...record, status: "expired" as const, sequence: record.sequence + 1 };
				this.records.set(record.id, clone(next));
				expired.push(clone(next));
			}
		}
		return expired;
	}
}

/**
 * Coordinates the control-plane half of an interaction resume.
 *
 * The coordinator deliberately knows nothing about Runner or RunnerSteps.
 * The caller supplies the policy re-authorizer and the continuation that owns
 * context/cursor rehydration. The store claim is the single-consumer fence;
 * a failed or concurrent second resume therefore cannot invoke the callback.
 */
export class InteractionResumeCoordinator {
	constructor(
		private readonly store: InteractionStore,
		private readonly reauthorize: InteractionReauthorize,
	) {}

	async resume(input: InteractionResumeRequest, callback: InteractionResumeCallback): Promise<InteractionRecord> {
		const record = await this.store.get(input.id);
		if (!record) throw new InteractionConflictError("interaction not found");
		if (record.request.principal?.id !== input.principalId)
			throw new InteractionAuthorizationError("interaction resume principal does not match the request");
		if (record.status !== "answered")
			throw new InteractionConflictError(`interaction cannot resume from status ${record.status}`);
		if (record.sequence !== input.sequence) throw new InteractionConflictError("interaction sequence mismatch");
		if (Date.parse(record.expiresAt) <= Date.now()) throw new InteractionConflictError("interaction has expired");

		// Re-authorize the immutable request before claiming the answer. This
		// permits a policy change to reject without consuming the answer, while
		// the subsequent atomic claim still fences concurrent resume attempts.
		await this.reauthorize(record.request);
		const claimed = await this.store.claim(input.id, input.principalId, input.sequence);
		await callback({ request: claimed.request, answer: claimed.answer, interaction: claimed });
		return claimed;
	}
}

export class DurableInteractionPort implements InteractionSuspensionPort {
	constructor(private readonly store: InteractionStore) {}
	async suspend(request: InteractionRequest): Promise<void> {
		const record = await this.store.create(request.request, request.decision);
		// A store adapter may normalize or clone records. Keep the port's
		// contract honest: a successful suspend means the record is visible,
		// including its run/cursor reference, before PolicyPipeline emits its
		// typed control signal.
		if (record.id !== request.id || record.request.requestId !== request.request.requestId) {
			throw new InteractionConflictError("interaction store returned a mismatched record");
		}
	}
}
