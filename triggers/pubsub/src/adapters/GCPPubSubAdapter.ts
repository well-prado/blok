/**
 * GCPPubSubAdapter - Google Cloud Pub/Sub adapter for PubSubTrigger
 *
 * Uses @google-cloud/pubsub for GCP Pub/Sub connectivity.
 * Requires: npm install @google-cloud/pubsub
 *
 * Environment variables:
 * - GOOGLE_CLOUD_PROJECT: GCP project ID
 * - GOOGLE_APPLICATION_CREDENTIALS: Path to service account key file (optional if using default credentials)
 * - PUBSUB_EMULATOR_HOST: Pub/Sub emulator host for local development (optional)
 */

import type { PubSubTriggerOpts } from "@blokjs/helper";
import type { Message, PubSub, Subscription } from "@google-cloud/pubsub";
import { v4 as uuid } from "uuid";
import type { PubSubAdapter, PubSubMessage } from "../PubSubTrigger";

/**
 * GCP Pub/Sub configuration
 */
export interface GCPPubSubConfig {
	projectId?: string;
	credentials?: {
		client_email: string;
		private_key: string;
	};
}

/**
 * GCPPubSubAdapter - Google Cloud Pub/Sub implementation
 */
export class GCPPubSubAdapter implements PubSubAdapter {
	readonly provider = "gcp" as const;

	private client: PubSub | undefined;
	private subscriptions: Map<string, Subscription> = new Map();
	private connected = false;
	private config: GCPPubSubConfig;

	/**
	 * Type-narrowing accessor for `this.client`. Field is undefined until
	 * `connect()` runs.
	 */
	private requireClient(): PubSub {
		if (!this.client) {
			throw new Error("[GCPPubSubAdapter] client is not initialised — call connect() first");
		}
		return this.client;
	}

	constructor(config?: GCPPubSubConfig) {
		this.config = {
			projectId: config?.projectId || process.env.GOOGLE_CLOUD_PROJECT,
			credentials: config?.credentials,
		};
	}

	/**
	 * Connect to GCP Pub/Sub
	 */
	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			// Dynamic import of @google-cloud/pubsub
			const { PubSub } = await import("@google-cloud/pubsub");

			this.client = new PubSub({
				projectId: this.config.projectId,
				credentials: this.config.credentials,
			});

			this.connected = true;
			console.log(`[GCPPubSubAdapter] Connected to GCP Pub/Sub: ${this.config.projectId}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to GCP Pub/Sub: ${(error as Error).message}. Make sure @google-cloud/pubsub is installed: npm install @google-cloud/pubsub`,
			);
		}
	}

	/**
	 * Disconnect from GCP Pub/Sub
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		try {
			// Close all subscriptions
			for (const [name, subscription] of this.subscriptions) {
				await subscription.close();
			}
			this.subscriptions.clear();

			await this.requireClient().close();
			this.connected = false;
			console.log("[GCPPubSubAdapter] Disconnected from GCP Pub/Sub");
		} catch (error) {
			console.error(`[GCPPubSubAdapter] Error disconnecting: ${(error as Error).message}`);
		}
	}

	/**
	 * Subscribe to a GCP Pub/Sub topic
	 */
	async subscribe(config: PubSubTriggerOpts, handler: (message: PubSubMessage) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected to GCP Pub/Sub. Call connect() first.");
		}

		if (!config.subscription) {
			throw new Error("[GCPPubSubAdapter] `subscription` is required — must be the GCP subscription name.");
		}
		const subscriptionName = config.subscription;

		// Get the subscription. The GCP SDK calls the per-subscription
		// deadline `maxAckDeadline` (a `Duration`); our author-facing
		// field is `ackDeadline` (seconds) for parity with other
		// providers. `Duration` is the GCP SDK's tc39-Temporal-shaped
		// shim — construct via `Duration.from({seconds})`.
		const { Duration } = await import("@google-cloud/pubsub");
		const subscription = this.requireClient().subscription(subscriptionName, {
			flowControl: {
				maxMessages: config.maxMessages || 10,
			},
			maxAckDeadline: Duration.from({ seconds: config.ackDeadline || 30 }),
		});

		// `deadLetterTopic` / `filter` are set at the GCP subscription
		// resource level — they can only be provisioned at create time (or
		// via setMetadata for the dead-letter policy). Reconcile them here:
		// create the subscription with the requested policy, or if it
		// already exists, verify it matches and throw on a mismatch rather
		// than silently ignoring the author's intent.
		await this.reconcileSubscriptionConfig(subscription, subscriptionName, config);

		// Translate `startFrom` into a GCP seek BEFORE attaching listeners,
		// so replay happens before the streaming pull starts delivering.
		// GCP seeks by timestamp/snapshot; there is no sequence-number seek.
		await this.applyStartFrom(subscription, config.startFrom);

		// Message handler
		const messageHandler = async (gcpMessage: Message) => {
			// Parse message data
			let body: unknown;
			try {
				const data = gcpMessage.data.toString();
				body = JSON.parse(data);
			} catch {
				body = gcpMessage.data.toString();
			}

			// Create pub/sub message
			const pubsubMessage: PubSubMessage = {
				id: gcpMessage.id || uuid(),
				body,
				attributes: gcpMessage.attributes || {},
				raw: gcpMessage,
				topic: config.topic,
				subscription: subscriptionName,
				publishTime: gcpMessage.publishTime ? new Date(gcpMessage.publishTime) : new Date(),
				ack: async () => {
					gcpMessage.ack();
				},
				nack: async () => {
					gcpMessage.nack();
				},
			};

			// Process message
			try {
				await handler(pubsubMessage);
			} catch (error) {
				console.error(`[GCPPubSubAdapter] Error processing message: ${(error as Error).message}`);
			}
		};

		// Error handler
		const errorHandler = (error: Error) => {
			console.error(`[GCPPubSubAdapter] Subscription error: ${error.message}`);
		};

		// Attach listeners
		subscription.on("message", messageHandler);
		subscription.on("error", errorHandler);

		// Store subscription reference
		this.subscriptions.set(subscriptionName, subscription);

		console.log(`[GCPPubSubAdapter] Subscribed to: ${subscriptionName}`);
	}

	/**
	 * Translate `startFrom` into a GCP `subscription.seek()`.
	 *
	 * - `"latest"` / unset → no-op (streaming pull already delivers only
	 *   messages published after the subscriber attaches).
	 * - `"earliest"` → seek to the epoch; GCP clamps to the retention floor
	 *   and replays everything still retained.
	 * - `{ timestamp }` (unix seconds) → seek to that wall-clock instant.
	 * - `{ seq }` → rejected: GCP Pub/Sub has no sequence-number cursor.
	 */
	private async applyStartFrom(subscription: Subscription, startFrom: PubSubTriggerOpts["startFrom"]): Promise<void> {
		if (startFrom === undefined || startFrom === "latest") return;
		if (startFrom === "earliest") {
			await subscription.seek(new Date(0));
			return;
		}
		if ("timestamp" in startFrom) {
			await subscription.seek(new Date(startFrom.timestamp * 1000));
			return;
		}
		// { seq } — GCP Pub/Sub seeks by timestamp or snapshot only; there is
		// no offset/sequence cursor. Reject loudly instead of silently
		// dropping the author's replay intent.
		throw new Error(
			"[GCPPubSubAdapter] startFrom `{seq}` is not supported — GCP Pub/Sub seeks by timestamp or snapshot only. Use `{timestamp}`, `earliest`, or `latest`.",
		);
	}

	/**
	 * Provision `deadLetterTopic` / `filter` on the subscription resource.
	 *
	 * These are create-time properties in GCP. When the subscription does
	 * not yet exist we create it with the requested policy/filter. When it
	 * already exists we verify the live metadata matches — `filter` is
	 * immutable so a mismatch throws; a dead-letter mismatch is patched via
	 * `setMetadata` (the one field GCP lets you change after creation).
	 */
	private async reconcileSubscriptionConfig(
		subscription: Subscription,
		subscriptionName: string,
		config: PubSubTriggerOpts,
	): Promise<void> {
		if (!config.deadLetterTopic && !config.filter) return;

		const deadLetterPolicy = config.deadLetterTopic
			? { deadLetterTopic: this.requireClient().topic(config.deadLetterTopic).name }
			: undefined;

		const [exists] = await subscription.exists();
		if (!exists) {
			// A subscription obtained via `client.subscription(name)` is
			// detached from its topic and the SDK refuses to `.create()` it
			// ("Subscriptions can only be created when accessed through
			// Topics"). Create through the topic instead.
			await this.requireClient()
				.topic(config.topic)
				.createSubscription(subscriptionName, {
					...(config.filter ? { filter: config.filter } : {}),
					...(deadLetterPolicy ? { deadLetterPolicy } : {}),
				});
			return;
		}

		const [metadata] = await subscription.getMetadata();

		// `filter` is immutable after creation — a mismatch means the caller
		// asked for a filter the pre-existing subscription can't honor.
		if (config.filter && (metadata.filter || "") !== config.filter) {
			throw new Error(
				`[GCPPubSubAdapter] subscription "${subscriptionName}" already exists with filter "${metadata.filter || ""}" which differs from the requested filter "${config.filter}". GCP filters are immutable; delete and recreate the subscription.`,
			);
		}

		if (deadLetterPolicy && metadata.deadLetterPolicy?.deadLetterTopic !== deadLetterPolicy.deadLetterTopic) {
			await subscription.setMetadata({ deadLetterPolicy });
		}
	}

	/**
	 * Unsubscribe from a GCP Pub/Sub subscription
	 */
	async unsubscribe(subscriptionName: string): Promise<void> {
		const subscription = this.subscriptions.get(subscriptionName);
		if (subscription) {
			await subscription.close();
			this.subscriptions.delete(subscriptionName);
			console.log(`[GCPPubSubAdapter] Unsubscribed from: ${subscriptionName}`);
		}
	}

	/**
	 * Check if connected to GCP Pub/Sub
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * v0.7 PR 6 — publish to a GCP Pub/Sub topic.
	 *
	 * `partitionKey` / `orderingKey` map to GCP's `orderingKey` (the
	 * topic must have message ordering enabled — otherwise the field
	 * is ignored by the broker).
	 */
	async publish(
		topic: string,
		payload: unknown,
		opts?: { partitionKey?: string; orderingKey?: string },
	): Promise<void> {
		if (!this.connected) throw new Error("[blok][pubsub-gcp] not connected. Call connect() first.");
		const body = typeof payload === "string" ? payload : JSON.stringify(payload);
		const t = this.requireClient().topic(topic);
		await t.publishMessage({
			data: Buffer.from(body),
			orderingKey: opts?.orderingKey ?? opts?.partitionKey,
		});
	}

	/**
	 * Health check - verify GCP Pub/Sub connectivity
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;

		try {
			// List subscriptions as a health check
			const [subscriptions] = await this.requireClient().getSubscriptions({ pageSize: 1 });
			return true;
		} catch {
			return false;
		}
	}
}

export default GCPPubSubAdapter;
