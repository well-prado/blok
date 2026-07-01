/**
 * SQSAdapter — v0.7 PR 5 — Worker adapter backed by AWS SQS via
 * `@aws-sdk/client-sqs`. Polls a queue URL (the `queue` field) with
 * long-polling; processes messages with manual delete (ACK).
 *
 * Semantics:
 *   - **Long polling**: `WaitTimeSeconds=20` by default — minimises
 *     poll cost. `concurrency` controls how many parallel
 *     `ReceiveMessage` loops run.
 *   - **Visibility timeout**: configured via `timeout` (ms → s).
 *     Messages reappear after this if the worker doesn't delete them.
 *   - **Retries**: SQS handles retries automatically via redrive
 *     policy on the queue itself. The adapter doesn't simulate
 *     retries client-side — set `MaxReceiveCount` on the queue's
 *     redrive policy and a DLQ via `deadLetterQueue`.
 *   - **FIFO support**: when the queue URL ends with `.fifo`, the
 *     adapter passes `MessageGroupId` from `dedupId` or a default.
 *
 * Requires `@aws-sdk/client-sqs` as a peer dependency:
 *
 *     bun add @aws-sdk/client-sqs
 *
 * Environment variables (standard AWS SDK):
 *   - `AWS_REGION`              — default `us-east-1`.
 *   - `AWS_ACCESS_KEY_ID`       — credentials (or use a profile).
 *   - `AWS_SECRET_ACCESS_KEY`
 *   - `SQS_ENDPOINT_URL`        — for local SQS (LocalStack / ElasticMQ).
 */

import type { WorkerTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { WorkerAdapter, WorkerJob, WorkerQueueStats } from "../WorkerTrigger";

export interface SQSConfig {
	region: string;
	endpoint?: string;
	waitTimeSeconds: number;
	maxNumberOfMessages: number;
}

interface SqsMessage {
	MessageId?: string;
	ReceiptHandle?: string;
	Body?: string;
	Attributes?: Record<string, string>;
	MessageAttributes?: Record<string, { StringValue?: string }>;
}

interface QueueRunner {
	stop: boolean;
	loops: number;
}

interface QueueStatsCounters {
	completed: number;
	failed: number;
	active: number;
}

export class SQSAdapter implements WorkerAdapter {
	readonly provider = "sqs" as const;
	private readonly config: SQSConfig;
	// biome-ignore lint/suspicious/noExplicitAny: @aws-sdk/client-sqs client + command types are loose.
	private client: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: same as above.
	private commands: any = null;
	private runners: Map<string, QueueRunner> = new Map();
	private connected = false;
	private stats: Map<string, QueueStatsCounters> = new Map();

	constructor(config?: Partial<SQSConfig>) {
		this.config = {
			region: config?.region ?? process.env.AWS_REGION ?? "us-east-1",
			endpoint: config?.endpoint ?? process.env.SQS_ENDPOINT_URL,
			waitTimeSeconds: config?.waitTimeSeconds ?? 20,
			maxNumberOfMessages: config?.maxNumberOfMessages ?? 10,
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: peer dep
			const sdk: any = await import("@aws-sdk/client-sqs");
			this.client = new sdk.SQSClient({ region: this.config.region, endpoint: this.config.endpoint });
			this.commands = sdk;
			this.connected = true;
		} catch (err) {
			throw new Error(
				`[blok][sqs] connect failed: ${(err as Error).message}. Install @aws-sdk/client-sqs as a peer dependency: bun add @aws-sdk/client-sqs`,
			);
		}
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		for (const runner of this.runners.values()) runner.stop = true;
		// Wait for in-flight loops to drain — up to 500ms each.
		const drainDeadline = Date.now() + 2000;
		while (Date.now() < drainDeadline) {
			let active = 0;
			for (const r of this.runners.values()) active += r.loops;
			if (active === 0) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		this.runners.clear();
		try {
			this.client?.destroy?.();
		} catch {
			/* ignore */
		}
		this.client = null;
		this.connected = false;
	}

	async process(config: WorkerTriggerOpts, handler: (job: WorkerJob) => Promise<void>): Promise<void> {
		if (!this.connected) throw new Error("[blok][sqs] not connected. Call connect() first.");
		const runner: QueueRunner = { stop: false, loops: 0 };
		this.runners.set(config.queue, runner);
		this.stats.set(config.queue, { completed: 0, failed: 0, active: 0 });
		const stats = this.stats.get(config.queue) as QueueStatsCounters;

		const concurrency = Math.max(1, config.concurrency ?? 1);
		for (let i = 0; i < concurrency; i += 1) {
			void this.runConsumerLoop(config, handler, runner, stats);
		}
	}

	private async runConsumerLoop(
		config: WorkerTriggerOpts,
		handler: (job: WorkerJob) => Promise<void>,
		runner: QueueRunner,
		stats: QueueStatsCounters,
	): Promise<void> {
		runner.loops += 1;
		try {
			while (!runner.stop) {
				let response: { Messages?: SqsMessage[] } = {};
				try {
					response = await this.client.send(
						new this.commands.ReceiveMessageCommand({
							QueueUrl: config.queue,
							MaxNumberOfMessages: Math.min(10, this.config.maxNumberOfMessages),
							WaitTimeSeconds: this.config.waitTimeSeconds,
							VisibilityTimeout: typeof config.timeout === "number" ? Math.ceil(config.timeout / 1000) : 30,
							AttributeNames: ["All"],
							MessageAttributeNames: ["All"],
						}),
					);
				} catch (err) {
					// Transient — back off briefly then retry.
					await new Promise((r) => setTimeout(r, 1000));
					continue;
				}
				const messages = response.Messages ?? [];
				for (const m of messages) {
					if (runner.stop) break;
					stats.active += 1;
					// Tracks whether the message has already been settled via
					// the WorkerJob API (`complete` / `fail`). Declared OUTSIDE
					// the try so the catch arm can read it and skip its own
					// nack/fail bookkeeping when the handler explicitly
					// settled. Without this flag we'd double-delete the
					// receipt handle AND a `fail()` call would be silently
					// overruled by the wrapper deleting the message anyway.
					// Caught by the real-broker integration test in
					// `__tests__/integration/sqs-adapter.real-sqs.test.ts`.
					let settled = false;
					try {
						const payloadString = m.Body ?? "";
						let data: unknown;
						try {
							data = payloadString.length > 0 ? JSON.parse(payloadString) : null;
						} catch {
							data = payloadString;
						}
						const headers: Record<string, string> = {};
						for (const [k, v] of Object.entries(m.MessageAttributes ?? {})) {
							if (typeof v.StringValue === "string") headers[k] = v.StringValue;
						}
						const job: WorkerJob = {
							id: m.MessageId ?? `${config.queue}:${uuid()}`,
							data,
							headers,
							queue: config.queue,
							priority: config.priority ?? 0,
							attempts: Number.parseInt(m.Attributes?.ApproximateReceiveCount ?? "1", 10) - 1,
							maxRetries: config.retries ?? 0,
							createdAt: new Date(),
							timeout: config.timeout,
							raw: m,
							complete: async () => {
								if (settled) return;
								if (m.ReceiptHandle) {
									await this.client.send(
										new this.commands.DeleteMessageCommand({
											QueueUrl: config.queue,
											ReceiptHandle: m.ReceiptHandle,
										}),
									);
								}
								stats.completed += 1;
								settled = true;
							},
							fail: async (_err: Error) => {
								if (settled) return;
								stats.failed += 1;
								// No DeleteMessage call — visibility timeout
								// expires and SQS returns the message to the
								// queue automatically. DLQ takeover happens via
								// the queue's RedrivePolicy + MaxReceiveCount.
								settled = true;
							},
						};
						await handler(job);
						if (!settled && config.ack !== false && m.ReceiptHandle) {
							await this.client.send(
								new this.commands.DeleteMessageCommand({ QueueUrl: config.queue, ReceiptHandle: m.ReceiptHandle }),
							);
							stats.completed += 1;
							settled = true;
						}
					} catch {
						if (!settled) {
							stats.failed += 1;
							// Leave the message in flight — SQS visibility
							// timeout expiry returns it to the queue.
						}
					} finally {
						stats.active = Math.max(0, stats.active - 1);
					}
				}
			}
		} finally {
			runner.loops -= 1;
		}
	}

	async addJob(
		queue: string,
		data: unknown,
		opts?: { priority?: number; delay?: number; retries?: number; timeout?: number; jobId?: string },
	): Promise<string> {
		if (!this.connected) throw new Error("[blok][sqs] not connected. Call connect() first.");
		const messageId = opts?.jobId ?? uuid();
		const isFifo = queue.endsWith(".fifo");
		const params: Record<string, unknown> = {
			QueueUrl: queue,
			MessageBody: typeof data === "string" ? data : JSON.stringify(data),
		};
		if (isFifo) {
			params.MessageGroupId = opts?.jobId ?? "default";
			params.MessageDeduplicationId = messageId;
		}
		if (typeof opts?.delay === "number" && opts.delay > 0) {
			// SQS rejects per-message DelaySeconds on FIFO queues (they only
			// support a queue-level delay). Fail fast with a clear message
			// instead of letting the SDK surface a cryptic AWS validation error.
			if (isFifo) {
				throw new Error(
					"[blok][sqs] per-message delay is not supported on FIFO queues; set a queue-level DelaySeconds attribute instead.",
				);
			}
			params.DelaySeconds = Math.min(900, Math.ceil(opts.delay / 1000));
		}
		const result = await this.client.send(new this.commands.SendMessageCommand(params));
		return (result.MessageId as string) ?? messageId;
	}

	async stopProcessing(queue: string): Promise<void> {
		const runner = this.runners.get(queue);
		if (runner) runner.stop = true;
	}

	isConnected(): boolean {
		return this.connected;
	}

	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;
		try {
			// ListQueues is a cheap permission probe.
			await this.client.send(new this.commands.ListQueuesCommand({ MaxResults: 1 }));
			return true;
		} catch {
			return false;
		}
	}

	async getQueueStats(queue: string): Promise<WorkerQueueStats> {
		const counters = this.stats.get(queue) ?? { completed: 0, failed: 0, active: 0 };
		let waiting = 0;
		let delayed = 0;
		try {
			const result = await this.client.send(
				new this.commands.GetQueueAttributesCommand({
					QueueUrl: queue,
					AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesDelayed"],
				}),
			);
			waiting = Number.parseInt(result.Attributes?.ApproximateNumberOfMessages ?? "0", 10);
			delayed = Number.parseInt(result.Attributes?.ApproximateNumberOfMessagesDelayed ?? "0", 10);
		} catch {
			/* ignore */
		}
		return {
			waiting,
			active: counters.active,
			completed: counters.completed,
			failed: counters.failed,
			delayed,
		};
	}
}
