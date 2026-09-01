import type { PolicyDecision, PolicyRequest } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import {
	DurableInteractionPort,
	InMemoryInteractionStore,
	InteractionAuthorizationError,
	InteractionConflictError,
} from "../../policy/InteractionStore";

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
});
