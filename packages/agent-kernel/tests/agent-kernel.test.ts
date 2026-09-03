import { MemorySessionStore } from "@blokjs/runner";
import type { SessionEventInput, SessionStore } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { AgentKernel, AgentKernelError, ModelStreamAssembler } from "../src";
import { FakeModelAdapter, adapterContractSuite, textResponse, toolResponse } from "../src/testing";

const sessionCreated = (sessionId: string): SessionEventInput => ({
	contractVersion: "1",
	schemaVersion: 1,
	id: `${sessionId}:created`,
	sessionId,
	kind: "session.created",
	visibility: "operational",
	actor: { kind: "system", id: "test" },
	occurredAt: "2026-09-02T12:00:00.000Z",
	payload: { sessionId },
});

async function storeWithSession(sessionId = "session-1"): Promise<SessionStore> {
	const store = new MemorySessionStore();
	await store.append({ sessionId, expectedSequence: 0, events: [sessionCreated(sessionId)] });
	return store;
}

async function events(
	store: SessionStore,
	sessionId: string,
): Promise<readonly import("@blokjs/shared").AgentSessionEvent[]> {
	const page = await store.read(sessionId, { afterSequence: 0, limit: 256 });
	return page.events;
}

describe("ModelStreamAssembler", () => {
	it("assembles text, usage and tool arguments deterministically", () => {
		const assembler = new ModelStreamAssembler();
		assembler.add({ kind: "text-delta", index: 0, text: "hel" });
		assembler.add({ kind: "text-delta", index: 1, text: "lo" });
		assembler.add({ kind: "usage", index: 2, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
		assembler.add({ kind: "finish", index: 3, reason: "stop" });
		expect(assembler.finish()).toMatchObject({ text: "hello", usage: { totalTokens: 3 }, finishReason: "stop" });
	});

	it("rejects an unfinished or malformed stream with stable errors", () => {
		const partial = new ModelStreamAssembler();
		partial.add({ kind: "text-delta", index: 0, text: "partial" });
		expect(() => partial.finish()).toThrowError(AgentKernelError);
		expect(() => partial.finish()).toThrow(/PARTIAL_STREAM|ended without/);
		const malformed = new ModelStreamAssembler();
		malformed.add({ kind: "tool-call-delta", index: 0, callId: "call-1", name: "lookup", argumentsDelta: "{" });
		malformed.add({ kind: "finish", index: 1, reason: "tool-call" });
		expect(() => malformed.finish()).toThrow(/MALFORMED_TOOL_CALL|invalid JSON/);
	});
});

describe("AgentKernel", () => {
	it("persists bounded stream facts and drives a terminal turn", async () => {
		const store = await storeWithSession();
		const kernel = new AgentKernel({ sessionStore: store, adapter: new FakeModelAdapter([textResponse("hello")]) });
		const accepted = await kernel.startTurn({ sessionId: "session-1", content: "say hello", turnId: "turn-1" });
		const result = await kernel.executeTurn(accepted);
		expect(result).toMatchObject({ status: "completed", content: "hello" });
		const persisted = await events(store, "session-1");
		expect(persisted.filter((event) => event.kind === "model.call.started")).toHaveLength(1);
		expect(persisted.filter((event) => event.kind === "model.stream")).toHaveLength(2);
		expect(persisted.filter((event) => event.kind === "message.assistant")).toHaveLength(1);
		expect(persisted.find((event) => event.kind === "turn.completed")?.payload).toMatchObject({ status: "completed" });
	});

	it("bounds provider retries before the first durable stream fact", async () => {
		const store = await storeWithSession();
		let attempts = 0;
		const kernel = new AgentKernel({
			sessionStore: store,
			adapter: new FakeModelAdapter(() => {
				attempts += 1;
				if (attempts === 1) throw new Error("429 rate limit");
				return textResponse("retried");
			}),
			maxRetries: 1,
		});
		const accepted = await kernel.startTurn({ sessionId: "session-1", content: "retry", turnId: "turn-retry" });
		await expect(kernel.executeTurn(accepted)).resolves.toMatchObject({ status: "completed", content: "retried" });
		expect(attempts).toBe(2);
	});

	it("routes model tool calls through the injected dispatcher before continuing", async () => {
		const store = await storeWithSession();
		const calls: string[] = [];
		const kernel = new AgentKernel({
			sessionStore: store,
			adapter: new FakeModelAdapter([
				toolResponse({ id: "call-1", name: "lookup", arguments: '{"key":"value"}' }),
				textResponse("done"),
			]),
			tools: [{ name: "lookup", inputSchema: { type: "object" } }],
			dispatcher: {
				async dispatch(request) {
					calls.push(`${request.name}:${request.idempotencyKey}`);
					return { content: { value: "found" } };
				},
			},
		});
		const accepted = await kernel.startTurn({ sessionId: "session-1", content: "lookup", turnId: "turn-1" });
		await expect(kernel.executeTurn(accepted)).resolves.toMatchObject({ status: "completed", content: "done" });
		expect(calls).toHaveLength(1);
		const persisted = await events(store, "session-1");
		expect(persisted.filter((event) => event.kind === "tool.call.started")).toHaveLength(1);
		expect(persisted.filter((event) => event.kind === "tool.call.completed")).toHaveLength(1);
	});

	it("applies steering only at the next model boundary", async () => {
		const store = await storeWithSession();
		const adapter = new FakeModelAdapter((request, callNumber) => {
			if (callNumber === 1) {
				expect(request.messages.at(-1)?.content).toContainEqual({ type: "json", value: "steer now" });
				return textResponse("done");
			}
			return toolResponse({ id: "call-1", name: "lookup", arguments: "{}" });
		});
		const kernel = new AgentKernel({
			sessionStore: store,
			adapter,
			tools: [{ name: "lookup", inputSchema: {} }],
			dispatcher: {
				async dispatch() {
					await kernel.steer("session-1", "turn-1", "steer now");
					return { content: "ok" };
				},
			},
		});
		const accepted = await kernel.startTurn({ sessionId: "session-1", content: "start", turnId: "turn-1" });
		await expect(kernel.executeTurn(accepted)).resolves.toMatchObject({ status: "completed", content: "done" });
	});

	it("records budget exhaustion and cancellation as terminal boundary facts", async () => {
		const store = await storeWithSession();
		const budgetKernel = new AgentKernel({
			sessionStore: store,
			adapter: new FakeModelAdapter([textResponse("too long")]),
			budgets: { maxOutputBytes: 2 },
		});
		const accepted = await budgetKernel.startTurn({ sessionId: "session-1", content: "budget", turnId: "turn-budget" });
		await expect(budgetKernel.executeTurn(accepted)).resolves.toMatchObject({
			status: "failed",
			error: { code: "BUDGET_EXCEEDED" },
		});
		const budgetEvents = await events(store, "session-1");
		expect(budgetEvents.some((event) => event.kind === "budget.exhausted")).toBe(true);

		const cancelStore = await storeWithSession("session-cancel");
		const cancelKernel = new AgentKernel({
			sessionStore: cancelStore,
			adapter: new FakeModelAdapter([textResponse("never")]),
		});
		const cancelAccepted = await cancelKernel.startTurn({
			sessionId: "session-cancel",
			content: "cancel",
			turnId: "turn-cancel",
		});
		await cancelKernel.cancel(cancelAccepted.sessionId, cancelAccepted.turnId);
		await expect(cancelKernel.executeTurn(cancelAccepted)).resolves.toMatchObject({
			status: "cancelled",
			error: { code: "CANCELLED" },
		});
	});

	it("does not repeat a model stream or an accepted tool call during recovery", async () => {
		const store = await storeWithSession();
		await store.append({
			sessionId: "session-1",
			expectedSequence: 1,
			events: [
				{
					...sessionCreated("session-1"),
					id: "session-1:turn.started",
					kind: "turn.started",
					turnId: "turn-1",
					payload: { turnId: "turn-1" },
				},
				{
					...sessionCreated("session-1"),
					id: "session-1:message.user",
					kind: "message.user",
					turnId: "turn-1",
					actor: { kind: "user", id: "user" },
					visibility: "model-visible",
					payload: "continue",
				},
			],
		});
		await store.append({
			sessionId: "session-1",
			expectedSequence: 3,
			events: [
				{
					...sessionCreated("session-1"),
					id: "session-1:model:stream",
					kind: "model.stream",
					turnId: "turn-1",
					payload: { step: 1, chunk: { kind: "text-delta", index: 0, text: "partial" } },
				},
			],
		});
		const adapter = new FakeModelAdapter([textResponse("should-not-run")]);
		const kernel = new AgentKernel({ sessionStore: store, adapter });
		const recovery = await kernel.recover("session-1");
		expect(recovery.failedTurnIds).toEqual(["turn-1"]);
		expect(adapter.calls).toBe(0);

		const secondStore = await storeWithSession("session-2");
		const base = sessionCreated("session-2");
		await secondStore.append({
			sessionId: "session-2",
			expectedSequence: 1,
			events: [
				{ ...base, id: "session-2:started", kind: "turn.started", turnId: "turn-2", payload: { turnId: "turn-2" } },
				{
					...base,
					id: "session-2:user",
					kind: "message.user",
					turnId: "turn-2",
					actor: { kind: "user", id: "user" },
					payload: "run",
				},
				{
					...base,
					id: "session-2:model:stream",
					kind: "model.stream",
					turnId: "turn-2",
					payload: {
						step: 1,
						chunk: { kind: "tool-call-delta", index: 0, callId: "call-1", name: "lookup", argumentsDelta: "{}" },
					},
				},
				{
					...base,
					id: "session-2:model:finish",
					kind: "model.stream",
					turnId: "turn-2",
					payload: { step: 1, chunk: { kind: "finish", index: 1, reason: "tool-call" } },
				},
				{
					...base,
					id: "session-2:model:complete",
					kind: "model.completed",
					turnId: "turn-2",
					payload: {
						step: 1,
						finishReason: "tool-call",
						usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
						toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }],
					},
				},
				{
					...base,
					id: "session-2:assistant",
					kind: "message.assistant",
					turnId: "turn-2",
					payload: { blocks: [{ type: "tool-call", id: "call-1", name: "lookup", arguments: {} }], text: "" },
				},
				{
					...base,
					id: "session-2:tool:started",
					kind: "tool.call.started",
					turnId: "turn-2",
					idempotencyKey: "turn-2:tool:1:call-1",
					payload: { id: "call-1", name: "lookup", arguments: {}, step: 1 },
				},
			],
		});
		const secondAdapter = new FakeModelAdapter([textResponse("should-not-run")]);
		const secondKernel = new AgentKernel({
			sessionStore: secondStore,
			adapter: secondAdapter,
			tools: [{ name: "lookup", inputSchema: {} }],
			dispatcher: {
				async dispatch() {
					throw new Error("must not dispatch");
				},
			},
		});
		const secondRecovery = await secondKernel.recover("session-2");
		expect(secondRecovery.failedTurnIds).toEqual(["turn-2"]);
		expect(secondAdapter.calls).toBe(0);
	});
});

describe("adapter contract suite", () => {
	for (const testCase of adapterContractSuite(() => new FakeModelAdapter([textResponse("ok")]))) {
		it(testCase.name, testCase.run);
	}
});
