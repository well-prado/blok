import type { PubSubMessage } from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AWSSNSAdapter } from "../../src/adapters/AWSSNSAdapter";

/**
 * Real LocalStack integration test for `AWSSNSAdapter` (issue #587).
 *
 * Stands up a genuine SNS->SQS topology via the AWS SDK against LocalStack:
 *   1. CreateTopic  (SNS)
 *   2. CreateQueue  (SQS)
 *   3. Subscribe    the queue to the topic (RawMessageDelivery=false → SNS
 *      envelope, which the adapter unwraps)
 *   4. SetQueueAttributes with an SQS access policy allowing SNS to deliver.
 *
 * Then proves the four behaviours the audit flagged:
 *   (1) publish to SNS  → the subscribed SQS queue receives + unwraps it.
 *   (2) `startFrom` set  → subscribe() throws a clear config error (SQS can't
 *       replay).
 *   (3) `consumerGroup` set → subscribe() logs a warning (SNS->SQS has no
 *       Kafka-style groups) but still works.
 *   (4) `ackDeadline` → the ReceiveMessageCommand carries VisibilityTimeout.
 *
 * Gated on `BLOK_INTEGRATION_AWS_ENDPOINT`. Skipped without it so the plain
 * unit run on a laptop with no LocalStack doesn't break.
 *
 * Run (LocalStack already up on :4566):
 *   BLOK_INTEGRATION_AWS_ENDPOINT=http://localhost:4566 \
 *   AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test \
 *   AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
 *   bunx vitest run __tests__/integration/aws-sns-pubsub.real-localstack.test.ts --root triggers/pubsub
 */

const AWS_ENDPOINT = process.env.BLOK_INTEGRATION_AWS_ENDPOINT;
const d = AWS_ENDPOINT ? describe : describe.skip;

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TEST_TIMEOUT_MS = 30_000;
const suffix = Math.random().toString(36).slice(2);

// Narrow shapes for the SDK bits this test touches — the repo's no-`any`
// rule wants a typed boundary, so these interfaces cover just the fields
// asserted on. Everything is loaded at runtime from the peer-dep clients.
interface SnsClientLike {
	send(command: unknown): Promise<{ TopicArn?: string }>;
	destroy?(): void;
}
interface SqsClientLike {
	send(command: unknown): Promise<{ QueueUrl?: string; Attributes?: Record<string, string> }>;
	destroy?(): void;
}
interface SnsModule {
	SNSClient: new (cfg: { region: string; endpoint?: string }) => SnsClientLike;
	CreateTopicCommand: new (input: { Name: string }) => unknown;
	DeleteTopicCommand: new (input: { TopicArn: string }) => unknown;
	SubscribeCommand: new (input: {
		TopicArn: string;
		Protocol: string;
		Endpoint: string;
		ReturnSubscriptionArn?: boolean;
	}) => unknown;
}
interface SqsModule {
	SQSClient: new (cfg: { region: string; endpoint?: string }) => SqsClientLike;
	CreateQueueCommand: new (input: { QueueName: string }) => unknown;
	DeleteQueueCommand: new (input: { QueueUrl: string }) => unknown;
	GetQueueAttributesCommand: new (input: { QueueUrl: string; AttributeNames: string[] }) => unknown;
	SetQueueAttributesCommand: new (input: { QueueUrl: string; Attributes: Record<string, string> }) => unknown;
}

d("AWSSNSAdapter — real LocalStack SNS->SQS", () => {
	let sns: SnsModule;
	let sqs: SqsModule;
	let snsClient: SnsClientLike;
	let sqsClient: SqsClientLike;
	let adapter: AWSSNSAdapter;

	let topicArn = "";
	let queueUrl = "";

	beforeAll(async () => {
		sns = (await import("@aws-sdk/client-sns")) as unknown as SnsModule;
		sqs = (await import("@aws-sdk/client-sqs")) as unknown as SqsModule;
		snsClient = new sns.SNSClient({ region: REGION, endpoint: AWS_ENDPOINT });
		sqsClient = new sqs.SQSClient({ region: REGION, endpoint: AWS_ENDPOINT });

		// 1. SNS topic
		const topicName = `blok-test-topic-${suffix}`;
		const topicRes = await snsClient.send(new sns.CreateTopicCommand({ Name: topicName }));
		topicArn = topicRes.TopicArn ?? "";
		expect(topicArn).toContain(topicName);

		// 2. SQS queue
		const queueName = `blok-test-queue-${suffix}`;
		const queueRes = await sqsClient.send(new sqs.CreateQueueCommand({ QueueName: queueName }));
		queueUrl = queueRes.QueueUrl ?? "";
		expect(queueUrl).toContain(queueName);

		// Queue ARN — needed for the SNS subscription endpoint + the SQS
		// access policy.
		const attrRes = await sqsClient.send(
			new sqs.GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
		);
		const queueArn = attrRes.Attributes?.QueueArn ?? "";
		expect(queueArn).toContain(queueName);

		// 4. SQS access policy — allow SNS to deliver to this queue.
		await sqsClient.send(
			new sqs.SetQueueAttributesCommand({
				QueueUrl: queueUrl,
				Attributes: {
					Policy: JSON.stringify({
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: { Service: "sns.amazonaws.com" },
								Action: "sqs:SendMessage",
								Resource: queueArn,
								Condition: { ArnEquals: { "aws:SourceArn": topicArn } },
							},
						],
					}),
				},
			}),
		);

		// 3. Subscribe the queue to the topic (SNS-envelope delivery).
		await snsClient.send(
			new sns.SubscribeCommand({
				TopicArn: topicArn,
				Protocol: "sqs",
				Endpoint: queueArn,
				ReturnSubscriptionArn: true,
			}),
		);

		adapter = new AWSSNSAdapter({ region: REGION, endpoint: AWS_ENDPOINT });
		await adapter.connect();
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		try {
			await adapter?.disconnect();
		} catch {
			/* best-effort */
		}
		// Tear down only the resources we created.
		try {
			if (queueUrl) await sqsClient.send(new sqs.DeleteQueueCommand({ QueueUrl: queueUrl }));
		} catch {
			/* best-effort */
		}
		try {
			if (topicArn) await snsClient.send(new sns.DeleteTopicCommand({ TopicArn: topicArn }));
		} catch {
			/* best-effort */
		}
		snsClient?.destroy?.();
		sqsClient?.destroy?.();
	}, TEST_TIMEOUT_MS);

	it(
		"publish to SNS is received (and unwrapped) by the subscribed SQS queue",
		async () => {
			const received: PubSubMessage[] = [];
			await adapter.subscribe({ topic: topicArn, subscription: queueUrl }, async (msg) => {
				received.push(msg);
				await msg.ack();
			});

			try {
				const payload = { hello: "aws", n: 42, run: suffix };
				await adapter.publish(topicArn, payload);

				await waitFor(() => received.length >= 1, TEST_TIMEOUT_MS - 5_000);

				// SNS wraps the payload in a Notification envelope; the adapter must
				// unwrap `Message` back to the original object.
				expect(received[0].body).toEqual(payload);
				expect(received[0].topic).toBe(topicArn);
				expect(received[0].subscription).toBe(queueUrl);
			} finally {
				// Stop this poller so it doesn't race the ackDeadline test's
				// spy on the same queue URL (poller map is keyed by URL).
				await adapter.unsubscribe(queueUrl);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it("subscribe with startFrom throws a clear config error (SQS cannot replay)", async () => {
		await expect(
			adapter.subscribe({ topic: topicArn, subscription: queueUrl, startFrom: "earliest" }, async () => {}),
		).rejects.toThrow(/startFrom.*not supported.*aws/i);
	});

	it("subscribe with consumerGroup warns but does not throw", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await adapter.subscribe({ topic: topicArn, subscription: queueUrl, consumerGroup: "my-group" }, async () => {});
			expect(warn).toHaveBeenCalled();
			const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
			expect(msg).toMatch(/consumerGroup/);
			expect(msg).toMatch(/aws/i);
		} finally {
			warn.mockRestore();
			// stop the poller this subscribe started (unique per queueUrl).
			await adapter.unsubscribe(queueUrl);
		}
	});

	it("ackDeadline is applied as VisibilityTimeout on the ReceiveMessageCommand", async () => {
		// Intercept the SQS client's send to inspect the real ReceiveMessage
		// input the adapter builds. Reaches into the connected adapter's
		// private client — the only way to observe the wire params without a
		// second live round-trip.
		const client = (adapter as unknown as { sqsClient: { send: (c: unknown) => Promise<unknown> } }).sqsClient;
		const originalSend = client.send.bind(client);
		// Collect every VisibilityTimeout the adapter puts on a ReceiveMessage.
		// Assert the specific ackDeadline (45) shows up — robust against any
		// other poller on the same queue also routing through this spy.
		const visibilityValues: (number | undefined)[] = [];
		const spy = vi.spyOn(client, "send").mockImplementation(async (command: unknown) => {
			const input = (command as { input?: Record<string, unknown> }).input;
			const name = (command as { constructor?: { name?: string } }).constructor?.name ?? "";
			if (name === "ReceiveMessageCommand" && input) {
				visibilityValues.push(input.VisibilityTimeout as number | undefined);
			}
			return originalSend(command);
		});
		try {
			await adapter.subscribe({ topic: topicArn, subscription: queueUrl, ackDeadline: 45 }, async (msg) => {
				await msg.ack();
			});
			await waitFor(() => visibilityValues.includes(45), TEST_TIMEOUT_MS - 5_000);
			expect(visibilityValues).toContain(45);
		} finally {
			spy.mockRestore();
			await adapter.unsubscribe(queueUrl);
		}
	});
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
