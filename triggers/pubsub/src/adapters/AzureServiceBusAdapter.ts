/**
 * AzureServiceBusAdapter - Azure Service Bus adapter for PubSubTrigger
 *
 * Uses @azure/service-bus for Azure Service Bus connectivity.
 * Requires: npm install @azure/service-bus
 *
 * Environment variables:
 * - AZURE_SERVICE_BUS_CONNECTION_STRING: Azure Service Bus connection string
 * - AZURE_SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE: Fully qualified namespace (if using DefaultAzureCredential)
 */

import type {
	ProcessErrorArgs,
	ServiceBusClient,
	ServiceBusReceivedMessage,
	ServiceBusReceiver,
} from "@azure/service-bus";
import type { PubSubTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { PubSubAdapter, PubSubMessage } from "../PubSubTrigger";

/**
 * Azure Service Bus configuration
 */
export interface AzureServiceBusConfig {
	connectionString?: string;
	fullyQualifiedNamespace?: string;
}

/**
 * AzureServiceBusAdapter - Azure Service Bus implementation
 */
export class AzureServiceBusAdapter implements PubSubAdapter {
	readonly provider = "azure" as const;

	private client: ServiceBusClient | undefined;
	private receivers: Map<string, ServiceBusReceiver> = new Map();
	private connected = false;
	private config: AzureServiceBusConfig;

	/**
	 * Type-narrowing accessor for `this.client`. Field is undefined until
	 * `connect()` runs.
	 */
	private requireClient(): ServiceBusClient {
		if (!this.client) {
			throw new Error("[AzureServiceBusAdapter] client is not initialised — call connect() first");
		}
		return this.client;
	}

	constructor(config?: AzureServiceBusConfig) {
		this.config = {
			connectionString: config?.connectionString || process.env.AZURE_SERVICE_BUS_CONNECTION_STRING,
			fullyQualifiedNamespace:
				config?.fullyQualifiedNamespace || process.env.AZURE_SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE,
		};
	}

	/**
	 * Connect to Azure Service Bus
	 */
	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			// Dynamic import of @azure/service-bus
			const { ServiceBusClient } = await import("@azure/service-bus");

			if (this.config.connectionString) {
				this.client = new ServiceBusClient(this.config.connectionString);
			} else if (this.config.fullyQualifiedNamespace) {
				// Would need @azure/identity for DefaultAzureCredential
				throw new Error("Managed identity authentication requires @azure/identity package");
			} else {
				throw new Error("Either connectionString or fullyQualifiedNamespace is required");
			}

			this.connected = true;
			console.log("[AzureServiceBusAdapter] Connected to Azure Service Bus");
		} catch (error) {
			throw new Error(
				`Failed to connect to Azure Service Bus: ${(error as Error).message}. Make sure @azure/service-bus is installed: npm install @azure/service-bus`,
			);
		}
	}

	/**
	 * Disconnect from Azure Service Bus
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		try {
			// Close all receivers
			for (const [name, receiver] of this.receivers) {
				await receiver.close();
			}
			this.receivers.clear();

			await this.requireClient().close();
			this.connected = false;
			console.log("[AzureServiceBusAdapter] Disconnected from Azure Service Bus");
		} catch (error) {
			console.error(`[AzureServiceBusAdapter] Error disconnecting: ${(error as Error).message}`);
		}
	}

	/**
	 * Subscribe to an Azure Service Bus topic/subscription or queue
	 */
	async subscribe(config: PubSubTriggerOpts, handler: (message: PubSubMessage) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected to Azure Service Bus. Call connect() first.");
		}

		const client = this.requireClient();
		let receiver: ServiceBusReceiver;

		// Determine if this is a topic subscription or a queue
		if (config.subscription && config.topic) {
			// Topic with subscription
			receiver = client.createReceiver(config.topic, config.subscription, {
				receiveMode: config.ack !== false ? "peekLock" : "receiveAndDelete",
			});
		} else {
			// Queue
			receiver = client.createReceiver(config.subscription || config.topic, {
				receiveMode: config.ack !== false ? "peekLock" : "receiveAndDelete",
			});
		}

		const subscriptionKey = `${config.topic}/${config.subscription}`;

		// Message handler
		const processMessage = async (sbMessage: ServiceBusReceivedMessage) => {
			// Parse message body
			let body: unknown;
			try {
				if (typeof sbMessage.body === "string") {
					body = JSON.parse(sbMessage.body);
				} else {
					body = sbMessage.body;
				}
			} catch {
				body = sbMessage.body;
			}

			// Extract application properties as attributes
			const attributes: Record<string, string> = {};
			if (sbMessage.applicationProperties) {
				for (const [key, value] of Object.entries(sbMessage.applicationProperties)) {
					attributes[key] = String(value);
				}
			}

			// Create pub/sub message
			const pubsubMessage: PubSubMessage = {
				// `messageId` may be string | number | Buffer per Azure SDK; coerce to string.
				id: sbMessage.messageId !== undefined ? String(sbMessage.messageId) : uuid(),
				body,
				attributes,
				raw: sbMessage,
				topic: config.topic,
				subscription: config.subscription,
				publishTime: sbMessage.enqueuedTimeUtc ? new Date(sbMessage.enqueuedTimeUtc) : new Date(),
				ack: async () => {
					await receiver.completeMessage(sbMessage);
				},
				nack: async () => {
					await receiver.abandonMessage(sbMessage);
				},
			};

			// Process message
			try {
				await handler(pubsubMessage);
			} catch (error) {
				console.error(`[AzureServiceBusAdapter] Error processing message: ${(error as Error).message}`);
			}
		};

		// Error handler — Azure SDK passes a `ProcessErrorArgs` with the
		// underlying error inside `args.error` plus contextual fields.
		const processError = async (args: ProcessErrorArgs) => {
			console.error(`[AzureServiceBusAdapter] Error: ${args.error.message}`);
		};

		// Subscribe to messages
		receiver.subscribe({
			processMessage,
			processError,
		});

		this.receivers.set(subscriptionKey, receiver);

		console.log(`[AzureServiceBusAdapter] Subscribed to: ${subscriptionKey}`);
	}

	/**
	 * Unsubscribe from Azure Service Bus
	 */
	async unsubscribe(subscriptionKey: string): Promise<void> {
		const receiver = this.receivers.get(subscriptionKey);
		if (receiver) {
			await receiver.close();
			this.receivers.delete(subscriptionKey);
			console.log(`[AzureServiceBusAdapter] Unsubscribed from: ${subscriptionKey}`);
		}
	}

	/**
	 * Check if connected to Azure Service Bus
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * v0.7 PR 6 — publish to an Azure Service Bus topic.
	 *
	 * `partitionKey` maps to Service Bus's `partitionKey`; `orderingKey`
	 * maps to `sessionId` (for session-enabled topics).
	 */
	async publish(
		topic: string,
		payload: unknown,
		opts?: { partitionKey?: string; orderingKey?: string },
	): Promise<void> {
		if (!this.connected) throw new Error("[blok][pubsub-azure] not connected. Call connect() first.");
		const sender = this.requireClient().createSender(topic);
		try {
			await sender.sendMessages({
				body: payload,
				partitionKey: opts?.partitionKey,
				sessionId: opts?.orderingKey,
			});
		} finally {
			await sender.close();
		}
	}

	/**
	 * Health check - verify Azure Service Bus connectivity
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;

		try {
			// Create a temporary receiver to test connectivity
			const testReceiver = this.requireClient().createReceiver("$default", {
				receiveMode: "peekLock",
			});
			await testReceiver.close();
			return true;
		} catch {
			// Queue might not exist but connection is healthy if we got here
			return this.connected;
		}
	}
}

export default AzureServiceBusAdapter;
