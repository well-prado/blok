/**
 * Gated on `BLOK_INTEGRATION_AZURE_SB`. Skipped when unset.
 *
 *   docker compose -f infra/testing/azure-servicebus.docker-compose.yml up -d
 *   BLOK_INTEGRATION_AZURE_SB=1 bunx vitest run triggers/pubsub/__tests__/integration/azure-servicebus-adapter.real-azure.test.ts --root triggers/pubsub
 */
import { randomBytes } from "node:crypto";
import { ServiceBusClient, type ServiceBusReceivedMessage, type ServiceBusReceiver } from "@azure/service-bus";
import type { PubSubTriggerOpts } from "@blokjs/helper";
import { describe, expect, it } from "vitest";
import type { PubSubMessage } from "../../src/PubSubTrigger";
import { AzureServiceBusAdapter } from "../../src/adapters/AzureServiceBusAdapter";

const RUN = process.env.BLOK_INTEGRATION_AZURE_SB;
const d = RUN ? describe : describe.skip;

const CONNECTION_STRING =
	process.env.BLOK_AZURE_SERVICEBUS_CONNECTION_STRING ??
	"Endpoint=sb://localhost:5674;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;";
const TOPIC = process.env.BLOK_AZURE_SERVICEBUS_TOPIC ?? "blok-topic";
const FANOUT_A = process.env.BLOK_AZURE_SERVICEBUS_FANOUT_A ?? "fanout-a";
const FANOUT_B = process.env.BLOK_AZURE_SERVICEBUS_FANOUT_B ?? "fanout-b";
const COMPETING = process.env.BLOK_AZURE_SERVICEBUS_COMPETING ?? "competing";
const DEADLETTER_SUB = process.env.BLOK_AZURE_SERVICEBUS_DEADLETTER_SUB ?? "deadletter-sub";
const TEST_TIMEOUT_MS = 45_000;

function runId(): string {
	return `blok-azure-${randomBytes(6).toString("hex")}`;
}

function bodyRecord(message: PubSubMessage | ServiceBusReceivedMessage): Record<string, unknown> | undefined {
	return message.body && typeof message.body === "object" && !Array.isArray(message.body)
		? (message.body as Record<string, unknown>)
		: undefined;
}

async function connectAdapter(): Promise<AzureServiceBusAdapter> {
	const adapter = new AzureServiceBusAdapter({ connectionString: CONNECTION_STRING });
	await adapter.connect();
	return adapter;
}

async function waitFor(predicate: () => boolean, timeoutMs = TEST_TIMEOUT_MS): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function receiveMatchingDeadLetter(
	receiver: ServiceBusReceiver,
	run: string,
): Promise<ServiceBusReceivedMessage | undefined> {
	for (let i = 0; i < 20; i++) {
		const messages = await receiver.receiveMessages(10, { maxWaitTimeInMs: 1000 });
		const match = messages.find((message) => bodyRecord(message)?.run === run);
		if (match) return match;
	}
	return undefined;
}

d("AzureServiceBusAdapter - real emulator", () => {
	it(
		"fans out one topic publish to two subscriptions",
		async () => {
			const adapter = await connectAdapter();
			const run = runId();
			const seenA: Record<string, unknown>[] = [];
			const seenB: Record<string, unknown>[] = [];
			try {
				await adapter.subscribe({ topic: TOPIC, subscription: FANOUT_A }, async (message) => {
					const body = bodyRecord(message);
					if (body?.run === run) seenA.push(body);
					await message.ack();
				});
				await adapter.subscribe({ topic: TOPIC, subscription: FANOUT_B }, async (message) => {
					const body = bodyRecord(message);
					if (body?.run === run) seenB.push(body);
					await message.ack();
				});

				await adapter.publish(TOPIC, { kind: "fanout", run });
				await waitFor(() => seenA.length === 1 && seenB.length === 1);

				expect(seenA[0]).toEqual({ kind: "fanout", run });
				expect(seenB[0]).toEqual({ kind: "fanout", run });
				expect(await adapter.healthCheck()).toBe(true);
			} finally {
				await adapter.disconnect();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"competes across two receivers on one subscription without duplicate delivery",
		async () => {
			const a = await connectAdapter();
			const b = await connectAdapter();
			const run = runId();
			const seen: { index: number; receiver: string }[] = [];
			try {
				const handler = (receiver: string) => async (message: PubSubMessage) => {
					const body = bodyRecord(message);
					if (body?.run === run && typeof body.index === "number") {
						seen.push({ index: body.index, receiver });
					}
					await message.ack();
				};

				await a.subscribe({ topic: TOPIC, subscription: COMPETING }, handler("a"));
				await b.subscribe({ topic: TOPIC, subscription: COMPETING }, handler("b"));

				for (let index = 0; index < 6; index++) {
					await a.publish(TOPIC, { kind: "competing", run, index });
				}
				await waitFor(() => seen.length >= 6);

				expect(seen).toHaveLength(6);
				expect(new Set(seen.map((item) => item.index)).size).toBe(6);
			} finally {
				await a.disconnect();
				await b.disconnect();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"dead-letters after repeated nacks",
		async () => {
			const adapter = await connectAdapter();
			const client = new ServiceBusClient(CONNECTION_STRING);
			const deadLetterReceiver = client.createReceiver(TOPIC, DEADLETTER_SUB, {
				receiveMode: "receiveAndDelete",
				subQueueType: "deadLetter",
			});
			const run = runId();
			let attempts = 0;
			try {
				await adapter.subscribe({ topic: TOPIC, subscription: DEADLETTER_SUB }, async (message) => {
					const body = bodyRecord(message);
					if (body?.run === run) {
						attempts++;
						await message.nack();
						return;
					}
					await message.ack();
				});

				await adapter.publish(TOPIC, { kind: "deadletter", run });
				const deadLetter = await receiveMatchingDeadLetter(deadLetterReceiver, run);

				expect(attempts).toBeGreaterThanOrEqual(2);
				if (!deadLetter) throw new Error("matching dead-letter message was not received");
				expect(bodyRecord(deadLetter)).toEqual({ kind: "deadletter", run });
			} finally {
				await deadLetterReceiver.close();
				await client.close();
				await adapter.disconnect();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it("rejects unsupported options instead of silently ignoring them", async () => {
		const adapter = await connectAdapter();
		const cases: PubSubTriggerOpts[] = [
			{ topic: TOPIC, subscription: FANOUT_A, consumerGroup: "group-a" },
			{ topic: TOPIC, subscription: FANOUT_A, durable: false },
			{ topic: TOPIC, subscription: FANOUT_A, startFrom: "earliest" },
			{ topic: TOPIC, subscription: FANOUT_A, deadLetterTopic: "elsewhere" },
			{ topic: TOPIC, subscription: FANOUT_A, maxMessages: 2 },
			{ topic: TOPIC, subscription: FANOUT_A, ackDeadline: 5 },
		];
		try {
			for (const config of cases) {
				await expect(adapter.subscribe(config, async () => {})).rejects.toThrow(/AzureServiceBusAdapter/);
			}
			await expect(adapter.publish(TOPIC, { run: runId() }, { orderingKey: "session-a" })).rejects.toThrow(
				/orderingKey/,
			);
		} finally {
			await adapter.disconnect();
		}
	});
});
