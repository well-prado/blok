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
