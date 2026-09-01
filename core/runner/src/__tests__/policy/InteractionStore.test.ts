import {
	INTERACTION_REDACTED_VALUE,
	type InteractionAttribution,
	InteractionContractError,
	type PolicyDecision,
	type PolicyRequest,
	parseInteractionAnswer,
	parseInteractionPayload,
} from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import {
	DurableInteractionPort,
	InMemoryInteractionStore,
	InteractionAuthorizationError,
	InteractionConflictError,
	InteractionResumeCoordinator,
} from "../../policy/InteractionStore";
import { reauthorizePolicyRequest } from "../../policy/PolicyPipeline";

const request: PolicyRequest = {
	requestId: "interaction-1",
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

describe("durable interaction store", () => {
	it("persists ask before returning and makes duplicate answers idempotent", async () => {
		const store = new InMemoryInteractionStore();
		await new DurableInteractionPort(store).suspend({ id: request.requestId, request, decision });
		const answer = { id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 0 };
		const first = await store.answer(answer);
		const duplicate = await store.answer(answer);
		expect(first.status).toBe("answered");
		expect(duplicate).toEqual(first);
	});

	it("rejects mismatched principals and stale sequences", async () => {
		const store = new InMemoryInteractionStore();
		await store.create(request, decision);
		await expect(store.answer({ id: request.requestId, principalId: "other", sequence: 0 })).rejects.toBeInstanceOf(
			InteractionAuthorizationError,
		);
		await expect(
			store.answer({ id: request.requestId, principalId: "principal-1", sequence: 4 }),
		).rejects.toBeInstanceOf(InteractionConflictError);
	});

	it("expires pending interactions and prevents later answers", async () => {
		const store = new InMemoryInteractionStore();
		await store.create(request, decision, { expiresAt: "2020-01-01T00:00:00.000Z" });
		const expired = await store.expire("2020-01-02T00:00:00.000Z");
		expect(expired[0]?.status).toBe("expired");
		await expect(
			store.answer({ id: request.requestId, principalId: "principal-1", sequence: 0 }),
		).rejects.toBeInstanceOf(InteractionConflictError);
	});

	it("claims an answered interaction once and rejects duplicate resume attempts", async () => {
		const store = new InMemoryInteractionStore();
		await store.create(request, decision);
		await store.answer({ id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 0 });
		const reauthorized: PolicyRequest[] = [];
		const resumed: unknown[] = [];
		const coordinator = new InteractionResumeCoordinator(store, (exactRequest) => {
			reauthorized.push(exactRequest);
		});

		const claimed = await coordinator.resume(
			{ id: request.requestId, principalId: "principal-1", sequence: 1 },
			({ request: exactRequest, answer }) => {
				resumed.push({ exactRequest, answer });
			},
		);

		expect(claimed.claimedBy).toBe("principal-1");
		expect(claimed.sequence).toBe(2);
		expect(reauthorized).toEqual([request]);
		expect(resumed).toEqual([{ exactRequest: request, answer: { approved: true } }]);
		await expect(
			coordinator.resume({ id: request.requestId, principalId: "principal-1", sequence: 1 }, () => {
				throw new Error("duplicate callback must not run");
			}),
		).rejects.toBeInstanceOf(InteractionConflictError);
		expect(resumed).toHaveLength(1);
	});

	it("rejects denied, cancelled, expired, stale, and unauthorized resume attempts", async () => {
		const denied = new InMemoryInteractionStore();
		await denied.create(request, decision);
		await denied.answer({ id: request.requestId, principalId: "principal-1", deny: true, sequence: 0 });
		const coordinator = new InteractionResumeCoordinator(denied, async () => undefined);
		await expect(
			coordinator.resume({ id: request.requestId, principalId: "principal-1", sequence: 1 }, async () => undefined),
		).rejects.toBeInstanceOf(InteractionConflictError);

		const cancelled = new InMemoryInteractionStore();
		await cancelled.create(request, decision);
		await cancelled.cancel(request.requestId, "principal-1", 0);
		await expect(
			new InteractionResumeCoordinator(cancelled, async () => undefined).resume(
				{ id: request.requestId, principalId: "principal-1", sequence: 1 },
				async () => undefined,
			),
		).rejects.toBeInstanceOf(InteractionConflictError);

		const expired = new InMemoryInteractionStore();
		await expired.create(request, decision, { expiresAt: "2020-01-01T00:00:00.000Z" });
		await expect(
			new InteractionResumeCoordinator(expired, async () => undefined).resume(
				{ id: request.requestId, principalId: "principal-1", sequence: 0 },
				async () => undefined,
			),
		).rejects.toBeInstanceOf(InteractionConflictError);

		const stale = new InMemoryInteractionStore();
		await stale.create(request, decision);
		await stale.answer({ id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 0 });
		await expect(
			new InteractionResumeCoordinator(stale, async () => undefined).resume(
				{ id: request.requestId, principalId: "principal-1", sequence: 0 },
				async () => undefined,
			),
		).rejects.toBeInstanceOf(InteractionConflictError);
		await expect(
			new InteractionResumeCoordinator(stale, async () => undefined).resume(
				{ id: request.requestId, principalId: "other", sequence: 1 },
				async () => undefined,
			),
		).rejects.toBeInstanceOf(InteractionAuthorizationError);
	});

	it("supports process-style rehydration and resumes only the post-suspension continuation", async () => {
		const store = new InMemoryInteractionStore();
		await store.create(request, decision);
		await store.answer({ id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 0 });

		// A new coordinator represents a fresh process. The continuation owns
		// restoring the durable cursor/state snapshot; the coordinator only
		// supplies the immutable request and answer to it.
		const persistedState = { committedEffect: "receipt-1", cursor: 2 };
		const preSuspensionEffects = 1;
		let postSuspensionEffects = 0;
		const restored: unknown[] = [];
		const freshProcess = new InteractionResumeCoordinator(store, (exactRequest) => {
			restored.push({ exactRequest, state: structuredClone(persistedState) });
		});
		await freshProcess.resume({ id: request.requestId, principalId: "principal-1", sequence: 1 }, ({ interaction }) => {
			expect(interaction.request).toEqual(request);
			if (persistedState.cursor === 2) postSuspensionEffects += 1;
		});

		expect(preSuspensionEffects).toBe(1);
		expect(postSuspensionEffects).toBe(1);
		expect(restored).toEqual([{ exactRequest: request, state: persistedState }]);
	});
	it("validates bounded JSON answers and rejects non-JSON values", () => {
		expect(() => parseInteractionPayload({ nested: { value: 1n } })).toThrow(InteractionContractError);
		expect(() => parseInteractionPayload({ value: Number.NaN })).toThrow(/finite numbers/);
		expect(() => parseInteractionPayload(Array.from({ length: 9 }, () => "x".repeat(8 * 1024)))).toThrow(/bytes/);
		expect(() => parseInteractionAnswer({ id: "i", principalId: "p", sequence: -1 })).toThrow(/sequence/);
	});

	it("returns deeply immutable, redacted snapshots with nested/parallel attribution", async () => {
		const attribution: InteractionAttribution = {
			rootId: "run-root",
			parentId: "run-parent",
			branchId: "branch-2",
			branchIndex: 2,
			branchPath: ["fan-out", "child-workflow"],
			depth: 2,
		};
		const requestWithSecrets: PolicyRequest = {
			...request,
			attribution,
			signal: new AbortController().signal,
			scope: {
				...request.scope,
				fragments: { tenant: "acme", sessionToken: "raw-session-token" },
			},
		};
		const store = new InMemoryInteractionStore();
		const created = await store.create(requestWithSecrets, { ...decision, reason: "approval for secret: raw-secret" });
		const answer = await store.answer({
			id: request.requestId,
			principalId: "principal-1",
			answer: { approved: true, token: "raw-answer-token", nested: { ok: "yes" } },
			sequence: 0,
		});

		expect(created.request.signal).toBeUndefined();
		expect(created.request.attribution).toEqual(attribution);
		expect(created.request.scope.fragments).toEqual({ tenant: "acme", sessionToken: INTERACTION_REDACTED_VALUE });
		expect(created.decision.reason).toBe(INTERACTION_REDACTED_VALUE);
		expect(answer.answer).toEqual({ approved: true, token: INTERACTION_REDACTED_VALUE, nested: { ok: "yes" } });
		expect(Object.isFrozen(answer)).toBe(true);
		expect(Object.isFrozen(answer.request)).toBe(true);
		expect(Object.isFrozen(answer.request.attribution)).toBe(true);
		expect(Object.isFrozen(answer.answer)).toBe(true);
		expect(JSON.stringify(answer)).not.toContain("raw-");

		const fetched = await store.get(request.requestId);
		expect(fetched).toEqual(answer);
	});

	it("rejects unauthorized cancellation and resolves cancellation with the expected sequence", async () => {
		const store = new InMemoryInteractionStore();
		await store.create(request, decision);
		await expect(store.cancel(request.requestId, "other", 0)).rejects.toBeInstanceOf(InteractionAuthorizationError);
		const cancelled = await store.cancel(request.requestId, "principal-1", 0);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.sequence).toBe(1);
		await expect(
			store.answer({ id: request.requestId, principalId: "principal-1", sequence: 1 }),
		).rejects.toBeInstanceOf(InteractionConflictError);
	});

	it("claims an answered interaction once without changing its terminal answer", async () => {
		const store = new InMemoryInteractionStore();
		await store.create(request, decision);
		await store.answer({ id: request.requestId, principalId: "principal-1", answer: { approved: true }, sequence: 0 });
		const claimed = await store.claim(request.requestId, "principal-1", 1);
		expect(claimed.status).toBe("answered");
		expect(claimed.claimedBy).toBe("principal-1");
		expect(claimed.claimedAt).toEqual(expect.any(String));
		expect(claimed.sequence).toBe(2);
		await expect(store.claim(request.requestId, "principal-1", 2)).rejects.toBeInstanceOf(InteractionConflictError);
	});
});
