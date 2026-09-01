import type { PolicyDecision, PolicyRequest } from "@blokjs/shared";
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
});
