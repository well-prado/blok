/**
 * F1 — PubSubTrigger must apply the middleware chain before running the
 * workflow body. Pre-fix `handleMessage` went straight from createContext
 * to `this.run(ctx)` and never called `applyMiddlewareChain`, so a workflow
 * triggered via pub/sub executed with NO middleware (process-global,
 * workflow-level, or trigger-level) — including auth gates.
 */

import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

const span = {
	setAttribute: vi.fn(),
	setStatus: vi.fn(),
	recordException: vi.fn(),
	end: vi.fn(),
};

vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (s: typeof span) => unknown) => fn(span),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createUpDownCounter: () => ({ add: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
			createObservableCounter: () => ({ addCallback: vi.fn() }),
			createObservableUpDownCounter: () => ({ addCallback: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

import type { TriggerResponse } from "@blokjs/runner";
import { PubSubTrigger } from "../src/PubSubTrigger";
import type { PubSubMessage } from "../src/PubSubTrigger";

class TestPubSubTrigger extends PubSubTrigger {
	protected nodes = {};
	protected workflows = {};
	public callOrder: string[] = [];

	override loadNodes(): void {}
	override loadWorkflows(): void {}

	// Spy on the inherited dispatch primitives — record call order.
	protected override async applyMiddlewareChain(): Promise<void> {
		this.callOrder.push("applyMiddlewareChain");
	}

	override async run(): Promise<TriggerResponse> {
		this.callOrder.push("run");
		return { ctx: { response: { data: {} } } as any, metrics: {} as any };
	}

	async drive(message: PubSubMessage): Promise<void> {
		(this as any).configuration = { init: vi.fn().mockResolvedValue(undefined), name: "pubsub-wf", nodes: {} };
		await (this as any).handleMessage(
			message,
			{ path: "pubsub-wf", config: { name: "pubsub-wf" } },
			{ topic: "orders", ack: true },
		);
	}
}

const makeMessage = (overrides: Partial<PubSubMessage> = {}): PubSubMessage => ({
	id: "msg-1",
	body: { event: "order.created" },
	attributes: { authorization: "Bearer t" },
	raw: {},
	topic: "orders",
	subscription: "sub",
	ack: vi.fn().mockResolvedValue(undefined),
	nack: vi.fn().mockResolvedValue(undefined),
	...overrides,
});

describe("PubSubTrigger — F1 middleware application", () => {
	beforeEach(() => {
		span.setAttribute.mockClear();
		span.recordException.mockClear();
	});

	it("calls applyMiddlewareChain BEFORE run()", async () => {
		const t = new TestPubSubTrigger();
		await t.drive(makeMessage());
		expect(t.callOrder).toEqual(["applyMiddlewareChain", "run"]);
	});

	it("a throwing middleware short-circuits — run() never executes, message nacked", async () => {
		class ThrowingMwTrigger extends TestPubSubTrigger {
			protected override async applyMiddlewareChain(): Promise<void> {
				this.callOrder.push("applyMiddlewareChain");
				throw new Error("401 unauthorized");
			}
		}
		const t = new ThrowingMwTrigger();
		const message = makeMessage();
		await t.drive(message);

		expect(t.callOrder).toEqual(["applyMiddlewareChain"]);
		expect(t.callOrder).not.toContain("run");
		// A throwing middleware propagates to the outer catch → nack.
		expect(message.nack).toHaveBeenCalled();
		expect(message.ack).not.toHaveBeenCalled();
	});
});
