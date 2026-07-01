/**
 * Gated on `BLOK_INTEGRATION_AZURE_SB`. Skipped when unset.
 *
 *   docker compose -f infra/testing/azure-servicebus.docker-compose.yml up -d
 *   BLOK_INTEGRATION_AZURE_SB=1 bunx vitest run triggers/pubsub/__tests__/integration/azure-servicebus-emulator.real-azure.test.ts --root triggers/pubsub
 */
import { randomBytes } from "node:crypto";
import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";
import { describe, expect, it } from "vitest";

const RUN = process.env.BLOK_INTEGRATION_AZURE_SB;
const d = RUN ? describe : describe.skip;

const CONNECTION_STRING =
	process.env.BLOK_AZURE_SERVICEBUS_CONNECTION_STRING ??
	"Endpoint=sb://localhost:5674;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;";
const HEALTH_URL = process.env.BLOK_AZURE_SERVICEBUS_HEALTH_URL ?? "http://localhost:5300/health";
const QUEUE = process.env.BLOK_AZURE_SERVICEBUS_QUEUE ?? "blok-queue";

async function waitForHealth(): Promise<void> {
	let lastStatus = 0;
	for (let i = 0; i < 60; i++) {
		try {
			const response = await fetch(HEALTH_URL);
			lastStatus = response.status;
			if (response.ok) return;
		} catch {
			lastStatus = 0;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(`Azure Service Bus emulator health check failed, last status ${lastStatus}`);
}

async function receiveMatching(
	receiver: ReturnType<ServiceBusClient["createReceiver"]>,
	messageId: string,
): Promise<ServiceBusReceivedMessage | undefined> {
	for (let i = 0; i < 10; i++) {
		const messages = await receiver.receiveMessages(10, { maxWaitTimeInMs: 1000 });
		const match = messages.find((message) => message.messageId === messageId);
		if (match) return match;
	}
	return undefined;
}

d("Azure Service Bus emulator", () => {
	it("boots from Config.json and moves a real queue message", async () => {
		await waitForHealth();

		const client = new ServiceBusClient(CONNECTION_STRING);
		const sender = client.createSender(QUEUE);
		const receiver = client.createReceiver(QUEUE, { receiveMode: "receiveAndDelete" });
		const messageId = `blok-azure-${randomBytes(6).toString("hex")}`;

		try {
			await sender.sendMessages({
				body: { ok: true, messageId },
				contentType: "application/json",
				messageId,
			});

			const message = await receiveMatching(receiver, messageId);
			expect(message?.messageId).toBe(messageId);
			expect(message?.body).toEqual({ ok: true, messageId });
		} finally {
			await receiver.close();
			await sender.close();
			await client.close();
		}
	}, 120_000);
});
