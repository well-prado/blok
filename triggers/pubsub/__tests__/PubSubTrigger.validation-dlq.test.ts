/**
 * ADR 0015 — a deterministic input-validation failure must NOT nack into an
 * unbounded redelivery loop (NATS/Redis/Kafka have no built-in delivery cap).
 * `handleMessage` ACKs it (dropping, or dead-lettering when configured) so the
 * broker stops redelivering. Contrast the F1 middleware test: a NON-validation
 * error still nacks (existing at-least-once behavior).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/api", () => {
	const noop = { setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} };
	return {
		trace: {
			getTracer: () => ({
				startActiveSpan: (...a: unknown[]) => {
					const fn = a.find((x) => typeof x === "function") as ((s: typeof noop) => unknown) | undefined;
					return fn?.(noop);
				},
				startSpan: () => noop,
			}),
			getActiveSpan: () => undefined,
			setSpan: (c: unknown) => c,
		},
		metrics: {
			getMeter: () => ({
				createCounter: () => ({ add: () => {} }),
				createHistogram: () => ({ record: () => {} }),
				createGauge: () => ({ record: () => {} }),
				createObservableGauge: () => ({ addCallback: () => {} }),
			}),
		},
		context: { active: () => ({}), with: (_c: unknown, fn: () => unknown) => fn() },
		propagation: { extract: (c: unknown) => c, inject: () => {} },
		SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
		SpanStatusCode: { OK: 0, ERROR: 1 },
		isSpanContextValid: () => false,
	};
});

import type { TriggerResponse } from "@blokjs/runner";
import { GlobalError, WORKFLOW_INPUT_VALIDATION } from "@blokjs/shared";
import { PubSubTrigger } from "../src/PubSubTrigger";
import type { PubSubAdapter, PubSubMessage } from "../src/PubSubTrigger";

/** Drives handleMessage with a `run` that throws the ADR-0015 tagged validation error. */
class ValidationFailingTrigger extends PubSubTrigger {
	protected nodes = {};
	protected workflows = {};
	public publishedTo: Array<{ topic: string; payload: unknown }> = [];

	override loadNodes(): void {}
	override loadWorkflows(): void {}
	protected override async applyMiddlewareChain(): Promise<void> {}

	override async run(): Promise<TriggerResponse> {
		const err = new GlobalError("Input validation failed: orderId (Required)");
		err.setCode(400);
		err.setName(WORKFLOW_INPUT_VALIDATION);
		throw err;
	}

	// Stub the pooled-adapter resolution to a spy so the DLQ path is observable.
	protected override async resolveAdapterForWorkflow(): Promise<PubSubAdapter> {
		return {
			provider: "gcp",
			publish: async (topic: string, payload: unknown) => {
				this.publishedTo.push({ topic, payload });
			},
		} as unknown as PubSubAdapter;
	}

	async drive(message: PubSubMessage, extraConfig: Record<string, unknown> = {}): Promise<void> {
		(this as unknown as { configuration: unknown }).configuration = {
			init: vi.fn().mockResolvedValue(undefined),
			name: "pubsub-wf",
			nodes: {},
		};
		await (
			this as unknown as { handleMessage: (m: PubSubMessage, w: unknown, c: unknown) => Promise<void> }
		).handleMessage(
			message,
			{ path: "pubsub-wf", config: { name: "pubsub-wf" } },
			{ topic: "orders", ack: true, ...extraConfig },
		);
	}
}

const makeMessage = (overrides: Partial<PubSubMessage> = {}): PubSubMessage => ({
	id: "msg-1",
	body: { event: "order.created" },
	attributes: {},
	raw: {},
	topic: "orders",
	subscription: "sub",
	ack: vi.fn().mockResolvedValue(undefined),
	nack: vi.fn().mockResolvedValue(undefined),
	...overrides,
});

describe("PubSubTrigger — validation 400 → DLQ/drop (ADR 0015)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("ACK-drops a validation failure (no nack) when no deadLetterTopic is set — stops the poison loop", async () => {
		const t = new ValidationFailingTrigger();
		const message = makeMessage();
		await t.drive(message);

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.nack).not.toHaveBeenCalled();
		expect(t.publishedTo).toHaveLength(0); // no DLQ configured → dropped
	});

	it("dead-letters the message body to deadLetterTopic, then ACKs", async () => {
		const t = new ValidationFailingTrigger();
		const message = makeMessage();
		await t.drive(message, { deadLetterTopic: "orders.dlq" });

		expect(t.publishedTo).toEqual([{ topic: "orders.dlq", payload: { event: "order.created" } }]);
		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.nack).not.toHaveBeenCalled();
	});

	it("validates declared workflow input (message body is producer input)", () => {
		const flag = (PubSubTrigger.prototype as unknown as { validatesDeclaredInput(): boolean }).validatesDeclaredInput();
		expect(flag).toBe(true);
	});
});
