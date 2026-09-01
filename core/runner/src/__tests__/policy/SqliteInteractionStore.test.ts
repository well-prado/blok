import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractionRecord, PolicyDecision, PolicyRequest } from "@blokjs/shared";
import { afterEach, describe, expect, it } from "vitest";
import { InteractionAuthorizationError, InteractionConflictError } from "../../policy/InteractionStore";
import { SqliteInteractionStore } from "../../policy/SqliteInteractionStore";

const request: PolicyRequest = {
	requestId: "sqlite-interaction-1",
	origin: "agent",
	principal: { id: "principal-1", kind: "test" },
	session: { id: "session-1" },
	turn: { id: "turn-1" },
	workflow: { name: "approval-test" },
	step: { id: "send", attempt: 1 },
	manifest: null,
	scope: { effects: ["network"], capabilities: ["network.send"], secrets: [], fragments: {} },
	layers: [{ name: "deployment", version: "v1" }],
};
const decision: PolicyDecision = { kind: "ask", id: "decision-1", reasonCode: "approval", policyVersion: "v1" };
type ClaimedInteractionRecord = InteractionRecord & { readonly claimedBy?: string; readonly claimedAt?: string };

let directory: string | undefined;
let store: SqliteInteractionStore | undefined;

afterEach(() => {
	store?.close();
	store = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

function createStore(): SqliteInteractionStore {
	directory = mkdtempSync(join(tmpdir(), "blok-interactions-"));
	store = new SqliteInteractionStore(join(directory, "interactions.db"));
	return store;
}

describe("SqliteInteractionStore", () => {
	it("persists records across a database reopen", async () => {
		const first = createStore();
		const created = await first.create(request, decision, { expiresAt: "2099-01-01T00:00:00.000Z" });
		first.close();

		const reopened = new SqliteInteractionStore(join(directory as string, "interactions.db"));
		store = reopened;
		expect(await reopened.get(request.requestId)).toEqual(created);
		const answered = await reopened.answer({
			id: request.requestId,
			principalId: "principal-1",
			answer: { approved: true },
			sequence: 0,
		});
		expect(answered.status).toBe("answered");
		reopened.close();

		const reopenedAgain = new SqliteInteractionStore(join(directory as string, "interactions.db"));
		store = reopenedAgain;
		expect((await reopenedAgain.get(request.requestId))?.status).toBe("answered");
	});

	it("returns immutable snapshots and makes exact duplicate answers idempotent", async () => {
		const db = createStore();
		const created = await db.create(request, decision);
		expect(() => {
			(created.request as { workflow: { name: string } }).workflow.name = "mutated";
		}).toThrow(TypeError);
		expect(() => {
			(created.decision as { id: string }).id = "mutated";
		}).toThrow(TypeError);
		const stored = await db.get(request.requestId);
		expect(stored?.request.workflow.name).toBe("approval-test");
		expect(stored?.decision.id).toBe("decision-1");

		const answer = { id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 0 };
		const first = await db.answer(answer);
		const duplicate = await db.answer(answer);
		expect(duplicate).toEqual(first);
		expect(() => {
			(duplicate.request as { workflow: { name: string } }).workflow.name = "mutated-again";
		}).toThrow(TypeError);
		expect((await db.get(request.requestId))?.request.workflow.name).toBe("approval-test");
	});

	it("enforces principal binding and optimistic sequence checks", async () => {
		const db = createStore();
		await db.create(request, decision);
		await expect(db.answer({ id: request.requestId, principalId: "other", sequence: 0 })).rejects.toBeInstanceOf(
			InteractionAuthorizationError,
		);
		await expect(
			db.answer({ id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 3 }),
		).rejects.toBeInstanceOf(InteractionConflictError);
		await db.answer({ id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 0 });
		await expect(
			db.answer({ id: request.requestId, principalId: "principal-1", answer: { approved: false }, sequence: 0 }),
		).rejects.toBeInstanceOf(InteractionConflictError);
	});

	it("claims answered interactions once with principal, sequence, status, and expiry fencing", async () => {
		const db = createStore();
		await db.create(request, decision, { expiresAt: "2099-01-01T00:00:00.000Z" });
		await expect(db.claim(request.requestId, "principal-1", 0)).rejects.toBeInstanceOf(InteractionConflictError);
		await db.answer({ id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 0 });

		await expect(db.claim(request.requestId, "other", 1)).rejects.toBeInstanceOf(InteractionAuthorizationError);
		await expect(db.claim(request.requestId, "principal-1", 0)).rejects.toBeInstanceOf(InteractionConflictError);
		const claimed = (await db.claim(request.requestId, "principal-1", 1)) as ClaimedInteractionRecord;
		expect(claimed.status).toBe("answered");
		expect(claimed.sequence).toBe(2);
		expect(claimed.claimedBy).toBe("principal-1");
		expect(claimed.claimedAt).toEqual(expect.any(String));
		await expect(db.claim(request.requestId, "principal-1", 1)).rejects.toBeInstanceOf(InteractionConflictError);

		const deniedRequest = { ...request, requestId: "sqlite-interaction-denied" };
		await db.create(deniedRequest, decision);
		await db.answer({ id: deniedRequest.requestId, principalId: "principal-1", deny: true, sequence: 0 });
		await expect(db.claim(deniedRequest.requestId, "principal-1", 1)).rejects.toBeInstanceOf(InteractionConflictError);
	});

	it("does not claim an answered interaction after its expiry", async () => {
		const db = createStore();
		await db.create(request, decision, { expiresAt: new Date(Date.now() + 25).toISOString() });
		await db.answer({ id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 0 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		await expect(db.claim(request.requestId, "principal-1", 1)).rejects.toBeInstanceOf(InteractionConflictError);
		expect((await db.get(request.requestId))?.sequence).toBe(1);
	});

	it("expires pending interactions and prevents later answers", async () => {
		const db = createStore();
		await db.create(request, decision, { expiresAt: "2020-01-01T00:00:00.000Z" });
		const expired = await db.expire("2020-01-02T00:00:00.000Z");
		expect(expired).toHaveLength(1);
		expect(expired[0]?.status).toBe("expired");
		expect(expired[0]?.sequence).toBe(1);
		await expect(db.answer({ id: request.requestId, principalId: "principal-1", sequence: 0 })).rejects.toBeInstanceOf(
			InteractionConflictError,
		);
	});

	it("cancels with the expected principal and sequence", async () => {
		const db = createStore();
		await db.create(request, decision);
		await expect(db.cancel(request.requestId, "other", 0)).rejects.toBeInstanceOf(InteractionAuthorizationError);
		const cancelled = await db.cancel(request.requestId, "principal-1", 0);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.sequence).toBe(1);
	});

	it("rejects oversized and non-JSON answers without changing the interaction", async () => {
		const db = createStore();
		await db.create(request, decision);
		await expect(
			db.answer({ id: request.requestId, principalId: "principal-1", answer: "x".repeat(64 * 1024), sequence: 0 }),
		).rejects.toBeInstanceOf(InteractionConflictError);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		await expect(
			db.answer({ id: request.requestId, principalId: "principal-1", answer: cyclic, sequence: 0 }),
		).rejects.toBeInstanceOf(InteractionConflictError);
		expect((await db.get(request.requestId))?.status).toBe("pending");
		expect((await db.get(request.requestId))?.sequence).toBe(0);
	});
});
